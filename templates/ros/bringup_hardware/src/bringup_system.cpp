// ros2_control hardware for a robot Bringup designed (docs/ros.md). The robot's own firmware runs host mode over its
// console: `H <left> <right>` (wheel duties -1..1) in, `R <now_ms> <distance_mm|-1> <left> <right>` out each control
// tick, followed by what the robot measured: ` E <left> <right>` (encoder counts, with encoders) and ` H <mrad>` (the
// gyro's heading, with an IMU). The console is a serial device (the real board over USB) or a TCP port (the same
// firmware in QEMU, whose wheels turn the MuJoCo model). Parameters, written by Bringup from the design:
//   port            /dev/ttyACM0, or tcp:127.0.0.1:5555 (launch argument port:= overrides it)
//   max_wheel_rad_s the wheel's loaded speed at duty 1 on the cell's nominal voltage: velocity command / this = duty
//   rad_per_count   2π / the encoder's counts per wheel turn, as the firmware counts them; absent without encoders
// Wheel states: with encoders, the counts the firmware read (position) and their change over the firmware's own time
// (velocity), so the diff-drive controller's odometry is the robot's measured motion. Without encoders, the duties
// applied times max_wheel_rad_s, integrated: an ESTIMATE, and the controllers' file says it runs open loop.
// Sensors: "range_sensor" (the firmware's distance reading, metres; +inf when nothing is in range) and, with an IMU,
// "imu" (orientation from the gyro's heading, yaw rate from its change; no accelerations: the broadcaster's
// covariance marks them unknown). A skid-steer robot's rear wheels (joints 3 and 4) report their side's front wheel.
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <thread>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
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
    learned_rad_s_ = info.hardware_parameters.count("max_wheel_rad_s") ? std::stod(info.hardware_parameters.at("max_wheel_rad_s")) : 10.0;
    rad_per_count_ = info.hardware_parameters.count("rad_per_count") ? std::stod(info.hardware_parameters.at("rad_per_count")) : 0.0;
    // Joints in the URDF's order: left, right, then a skid-steer robot's left rear and right rear.
    if (info.joints.size() != 2 && info.joints.size() != 4) {
      RCLCPP_ERROR(get_logger(), "expected 2 or 4 wheel joints, got %zu", info.joints.size());
      return CallbackReturn::ERROR;
    }
    cmd_.assign(info.joints.size(), 0.0);
    pos_.assign(info.joints.size(), 0.0);
    vel_.assign(info.joints.size(), 0.0);
    imu_.assign(10, 0.0);
    imu_[3] = 1.0;  // orientation.w: no rotation until the gyro reports
    return CallbackReturn::SUCCESS;
  }

  std::vector<hardware_interface::StateInterface> export_state_interfaces() override {
    std::vector<hardware_interface::StateInterface> s;
    for (size_t i = 0; i < pos_.size(); i++) {
      s.emplace_back(info_.joints[i].name, hardware_interface::HW_IF_POSITION, &pos_[i]);
      s.emplace_back(info_.joints[i].name, hardware_interface::HW_IF_VELOCITY, &vel_[i]);
    }
    static const char *IMU[10] = {"orientation.x", "orientation.y", "orientation.z", "orientation.w", "angular_velocity.x", "angular_velocity.y", "angular_velocity.z", "linear_acceleration.x", "linear_acceleration.y", "linear_acceleration.z"};
    for (const auto &sensor : info_.sensors)
      for (const auto &si : sensor.state_interfaces) {
        double *at = &range_m_;
        for (int k = 0; k < 10; k++)
          if (sensor.name == "imu" && si.name == IMU[k]) at = &imu_[k];
        if (sensor.name == "imu" && at == &range_m_) at = &unused_;
        s.emplace_back(sensor.name, si.name, at);
      }
    return s;
  }

  std::vector<hardware_interface::CommandInterface> export_command_interfaces() override {
    std::vector<hardware_interface::CommandInterface> c;
    for (size_t i = 0; i < cmd_.size(); i++) c.emplace_back(info_.joints[i].name, hardware_interface::HW_IF_VELOCITY, &cmd_[i]);
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
    RCLCPP_INFO(get_logger(), "talking to the firmware on %s (max %.2f rad/s at duty 1, %s)", port_.c_str(), max_rad_s_, rad_per_count_ > 0 ? "wheel states from the encoders" : "no encoders: wheel states estimated from the duties");
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
        int d, used = 0;
        float l, r;
        if (sscanf(line.c_str(), "R %lu %d %f %f%n", &now, &d, &l, &r, &used) == 4) {
          applied_[0] = l;
          applied_[1] = r;
          range_m_ = d < 0 ? std::numeric_limits<double>::infinity() : d / 1000.0;
          report_tail(now, line.c_str() + used);
          if (++reports_ == 50 && rad_per_count_ > 0 && !have_counts_)
            RCLCPP_WARN(get_logger(), "the design has encoders but the firmware reports no counts (are ENC_LA/ENC_RA wired?): wheel states are estimated from the duties");
        }
      }
      if (rx_.size() > 4096) rx_.clear();
    }
    for (size_t i = 0; i < pos_.size(); i++) {
      if (rad_per_count_ > 0 && have_counts_) {
        pos_[i] = wheel_pos_[i % 2];
        vel_[i] = wheel_vel_[i % 2];
      } else {  // no encoders, or none reported yet (encoder pins left unwired): the estimate from the duties
        vel_[i] = applied_[i % 2] * max_rad_s_;
        pos_[i] += vel_[i] * period.seconds();
      }
    }
    return return_type::OK;
  }

  // The velocity command as duty. Feed-forward: command / the wheels' speed at duty 1: max_wheel_rad_s (the motor
  // model's loaded speed, an ESTIMATE: a QEMU rover drove 0.40 m/s on a 0.3 m/s command with it alone, 23 Nov 2026),
  // learned from the encoders while a wheel runs on a steady duty. With encoders a PI loop on each wheel's measured
  // speed corrects the rest. Its integral resets whenever the command is zero (a stop stays a stop) and holds while
  // the wheel hasn't answered yet (under half the command): the motor's delay wound it up, and the wheels overshot to
  // 12 rad/s on a 7.5 rad/s command.
  return_type write(const rclcpp::Time &, const rclcpp::Duration &period) override {
    double duty[2];
    for (int i = 0; i < 2; i++) {
      const bool measured = rad_per_count_ > 0 && have_counts_;
      const double k = measured ? learned_rad_s_ : max_rad_s_;
      duty[i] = cmd_[i] / k;
      if (measured) {
        if (std::abs(cmd_[i]) < 1e-3) {
          integ_[i] = 0;
          duty[i] = 0;
        } else {
          const double err = cmd_[i] - wheel_vel_[i];
          if (std::abs(wheel_vel_[i]) > 0.5 * std::abs(cmd_[i]))
            integ_[i] = std::clamp(integ_[i] + KI * err * period.seconds(), -0.5 * k, 0.5 * k);
          duty[i] += (KP * err + integ_[i]) / k;
        }
      }
    }
    send(duty[0], duty[1]);
    return return_type::OK;
  }

 private:
  int open_port(const std::string &port) {
    is_socket_ = port.rfind("tcp:", 0) == 0;
    if (is_socket_) {
      const auto rest = port.substr(4);
      const auto colon = rest.rfind(':');
      sockaddr_in a{};
      a.sin_family = AF_INET;
      a.sin_port = htons(std::stoi(rest.substr(colon + 1)));
      inet_pton(AF_INET, rest.substr(0, colon).c_str(), &a.sin_addr);
      const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
      if (fd >= 0 && ::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) != 0) {
        ::close(fd);
        return -1;
      }
      if (fd < 0) return -1;
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

  // What follows the four fixed fields: " E <left> <right>" and " H <mrad>", each optional, in any order.
  void report_tail(unsigned long now, const char *p) {
    for (;;) {
      while (*p == ' ') p++;
      char *end;
      if (p[0] == 'E' && p[1] == ' ') {
        const long cl = std::strtol(p + 2, &end, 10);
        const long cr = std::strtol(end, &end, 10);
        p = end;
        if (rad_per_count_ <= 0) continue;
        // The firmware counts from its boot: the first report is the zero, so odometry starts where ROS does.
        if (!have_counts_) {
          count0_[0] = cl;
          count0_[1] = cr;
        }
        const double wl = (cl - count0_[0]) * rad_per_count_, wr = (cr - count0_[1]) * rad_per_count_;
        const double dt = have_counts_ ? (now - counts_at_) / 1000.0 : 0.0;
        if (dt > 0) {
          wheel_vel_[0] = (wl - wheel_pos_[0]) / dt;
          wheel_vel_[1] = (wr - wheel_pos_[1]) / dt;
          learn();
        }
        if (!have_counts_ || dt > 0) counts_at_ = now;
        wheel_pos_[0] = wl;
        wheel_pos_[1] = wr;
        have_counts_ = true;
      } else if (p[0] == 'H' && p[1] == ' ') {
        const double yaw = std::strtol(p + 2, &end, 10) / 1000.0;
        p = end;
        const double dt = have_heading_ ? (now - heading_at_) / 1000.0 : 0.0;
        if (dt > 0) imu_[6] = std::remainder(yaw - yaw_, 2 * M_PI) / dt;
        if (!have_heading_ || dt > 0) heading_at_ = now;
        yaw_ = yaw;
        have_heading_ = true;
        imu_[0] = imu_[1] = 0.0;
        imu_[2] = std::sin(yaw / 2);
        imu_[3] = std::cos(yaw / 2);
      } else {
        return;
      }
    }
  }

  // The wheels' speed at duty 1, from what the encoders measured: once a wheel's applied duty has held (within 0.02)
  // for 8 reports (~0.25 s, past the motor's delay) above 0.15, its speed / duty moves the estimate 5 % of the way.
  // Kept within half to twice the motor model's, so a stalled or lifted wheel can't run it away.
  void learn() {
    for (int i = 0; i < 2; i++) {
      steady_[i] = std::abs(applied_[i] - last_applied_[i]) < 0.02 ? steady_[i] + 1 : 0;
      last_applied_[i] = applied_[i];
      if (steady_[i] >= 8 && std::abs(applied_[i]) > 0.15 && wheel_vel_[i] * applied_[i] > 0)
        learned_rad_s_ = std::clamp(learned_rad_s_ + 0.05 * (wheel_vel_[i] / applied_[i] - learned_rad_s_), 0.5 * max_rad_s_, 2.0 * max_rad_s_);
    }
  }

  void send(double l, double r) {
    if (fd_ < 0) return;
    char line[48];
    const int n = snprintf(line, sizeof line, "H %.3f %.3f\n", std::clamp(l, -1.0, 1.0), std::clamp(r, -1.0, 1.0));
    // A socket's peer gone (QEMU ended) must not raise SIGPIPE: it killed the whole ros2_control_node (23 Nov 2026).
    // MSG_NOSIGNAL turns it into an error here; a serial device unplugged fails the write the same way.
    const ssize_t w = is_socket_ ? ::send(fd_, line, n, MSG_NOSIGNAL) : ::write(fd_, line, n);
    if (w < 0) RCLCPP_WARN_THROTTLE(get_logger(), *rclcpp::Clock::make_shared(), 2000, "write to the firmware failed");
  }

  // The speed loop's gains, per (rad/s of error): ESTIMATES, tuned on the QEMU rover (docs/ros.md).
  static constexpr double KP = 0.5, KI = 2.0;
  double integ_[2] = {0, 0}, last_applied_[2] = {0, 0}, learned_rad_s_ = 0;
  int steady_[2] = {0, 0};
  std::string port_, rx_;
  double max_rad_s_ = 10.0, rad_per_count_ = 0.0;
  int connect_timeout_s_ = 120;
  int fd_ = -1;
  bool is_socket_ = false;
  std::vector<double> cmd_, pos_, vel_, imu_;
  double wheel_pos_[2] = {0, 0}, wheel_vel_[2] = {0, 0}, yaw_ = 0, unused_ = 0;
  unsigned long counts_at_ = 0, heading_at_ = 0;
  long count0_[2] = {0, 0};
  bool have_counts_ = false, have_heading_ = false;
  double applied_[2] = {0, 0};
  double range_m_ = std::numeric_limits<double>::infinity();
  unsigned long reports_ = 0;
};
}  // namespace bringup_hardware

#include "pluginlib/class_list_macros.hpp"
PLUGINLIB_EXPORT_CLASS(bringup_hardware::BringupSystem, hardware_interface::SystemInterface)
