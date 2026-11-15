// ros2_control hardware for a robot Bringup designed (docs/ros.md). The robot's own firmware runs host mode over its
// console: `H <left> <right>` (wheel duties -1..1) in, `R <now_ms> <distance_mm|-1> <left> <right>` out each control
// tick. The console is a serial device (the real board over USB) or a TCP port (the same firmware in QEMU, whose
// wheels turn the MuJoCo model). Parameters, written by Bringup from the design:
//   port            /dev/ttyACM0, or tcp:127.0.0.1:5555
//   max_wheel_rad_s the wheel's loaded speed at duty 1 on the cell's nominal voltage: velocity command / this = duty
// No encoders on today's robots: the wheel states are the duties the firmware applied, times max_wheel_rad_s (an
// estimate, said so), integrated for position. The range state is the firmware's own distance reading, in metres.
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <thread>
#include <cstdio>
#include <string>
#include <vector>

#include "hardware_interface/system_interface.hpp"
#include "hardware_interface/types/hardware_interface_type_values.hpp"
#include "rclcpp/rclcpp.hpp"

namespace bringup_hardware {
using hardware_interface::CallbackReturn;
using hardware_interface::return_type;

class BringupSystem : public hardware_interface::SystemInterface {
 public:
  CallbackReturn on_init(const hardware_interface::HardwareInfo &info) override {
    if (SystemInterface::on_init(info) != CallbackReturn::SUCCESS) return CallbackReturn::ERROR;
    port_ = info.hardware_parameters.count("port") ? info.hardware_parameters.at("port") : "tcp:127.0.0.1:5555";
    max_rad_s_ = info.hardware_parameters.count("max_wheel_rad_s") ? std::stod(info.hardware_parameters.at("max_wheel_rad_s")) : 10.0;
    connect_timeout_s_ = info.hardware_parameters.count("connect_timeout_s") ? std::stoi(info.hardware_parameters.at("connect_timeout_s")) : 120;
    if (info.joints.size() != 2) {
      RCLCPP_ERROR(get_logger(), "expected 2 wheel joints, got %zu", info.joints.size());
      return CallbackReturn::ERROR;
    }
    cmd_.assign(2, 0.0);
    pos_.assign(2, 0.0);
    vel_.assign(2, 0.0);
    return CallbackReturn::SUCCESS;
  }

  std::vector<hardware_interface::StateInterface> export_state_interfaces() override {
    std::vector<hardware_interface::StateInterface> s;
    for (size_t i = 0; i < 2; i++) {
      s.emplace_back(info_.joints[i].name, hardware_interface::HW_IF_POSITION, &pos_[i]);
      s.emplace_back(info_.joints[i].name, hardware_interface::HW_IF_VELOCITY, &vel_[i]);
    }
    for (const auto &sensor : info_.sensors)
      for (const auto &si : sensor.state_interfaces) s.emplace_back(sensor.name, si.name, &range_m_);
    return s;
  }

  std::vector<hardware_interface::CommandInterface> export_command_interfaces() override {
    std::vector<hardware_interface::CommandInterface> c;
    for (size_t i = 0; i < 2; i++) c.emplace_back(info_.joints[i].name, hardware_interface::HW_IF_VELOCITY, &cmd_[i]);
    return c;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override {
    // The robot may still be booting (a real board after power-up, the firmware in QEMU after its build): keep trying
    // for connect_timeout_s (default 120 s) before giving up.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(connect_timeout_s_);
    while ((fd_ = open_port(port_)) < 0 && std::chrono::steady_clock::now() < deadline) {
      RCLCPP_INFO_THROTTLE(get_logger(), *rclcpp::Clock::make_shared(), 5000, "waiting for the firmware on %s", port_.c_str());
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    if (fd_ < 0) {
      RCLCPP_ERROR(get_logger(), "can't open %s after %d s", port_.c_str(), connect_timeout_s_);
      return CallbackReturn::ERROR;
    }
    RCLCPP_INFO(get_logger(), "talking to the firmware on %s (max %.2f rad/s at duty 1)", port_.c_str(), max_rad_s_);
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override {
    send(0, 0);
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
    return CallbackReturn::SUCCESS;
  }

  return_type read(const rclcpp::Time &, const rclcpp::Duration &period) override {
    char buf[512];
    ssize_t n;
    while ((n = ::read(fd_, buf, sizeof buf)) > 0) {
      rx_.append(buf, n);
      size_t nl;
      while ((nl = rx_.find('\n')) != std::string::npos) {
        const std::string line = rx_.substr(0, nl);
        rx_.erase(0, nl + 1);
        unsigned long now;
        int d;
        float l, r;
        if (sscanf(line.c_str(), "R %lu %d %f %f", &now, &d, &l, &r) == 4) {
          applied_[0] = l;
          applied_[1] = r;
          range_m_ = d < 0 ? std::numeric_limits<double>::infinity() : d / 1000.0;
          reports_++;
        }
      }
      if (rx_.size() > 4096) rx_.clear();
    }
    for (size_t i = 0; i < 2; i++) {
      vel_[i] = applied_[i] * max_rad_s_;
      pos_[i] += vel_[i] * period.seconds();
    }
    return return_type::OK;
  }

  return_type write(const rclcpp::Time &, const rclcpp::Duration &) override {
    send(cmd_[0] / max_rad_s_, cmd_[1] / max_rad_s_);
    return return_type::OK;
  }

 private:
  static int open_port(const std::string &port) {
    if (port.rfind("tcp:", 0) == 0) {
      const auto rest = port.substr(4);
      const auto colon = rest.rfind(':');
      sockaddr_in a{};
      a.sin_family = AF_INET;
      a.sin_port = htons(std::stoi(rest.substr(colon + 1)));
      inet_pton(AF_INET, rest.substr(0, colon).c_str(), &a.sin_addr);
      const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
      if (fd < 0 || ::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) != 0) return -1;
      fcntl(fd, F_SETFL, O_NONBLOCK);
      return fd;
    }
    const int fd = ::open(port.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) return -1;
    termios t{};
    tcgetattr(fd, &t);
    cfmakeraw(&t);
    cfsetspeed(&t, B115200);
    tcsetattr(fd, TCSANOW, &t);
    return fd;
  }

  void send(double l, double r) {
    if (fd_ < 0) return;
    char line[48];
    const int n = snprintf(line, sizeof line, "H %.3f %.3f\n", std::clamp(l, -1.0, 1.0), std::clamp(r, -1.0, 1.0));
    if (::write(fd_, line, n) < 0) RCLCPP_WARN_THROTTLE(get_logger(), *rclcpp::Clock::make_shared(), 2000, "write to the firmware failed");
  }

  std::string port_, rx_;
  double max_rad_s_ = 10.0;
  int connect_timeout_s_ = 120;
  int fd_ = -1;
  std::vector<double> cmd_, pos_, vel_;
  double applied_[2] = {0, 0};
  double range_m_ = std::numeric_limits<double>::infinity();
  unsigned long reports_ = 0;
};
}  // namespace bringup_hardware

#include "pluginlib/class_list_macros.hpp"
PLUGINLIB_EXPORT_CLASS(bringup_hardware::BringupSystem, hardware_interface::SystemInterface)
