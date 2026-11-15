# Bringup's ROS 2 test image (docs/ros.md): Jazzy with ros2_control, the standard controllers, robot_state_publisher
# and foxglove_bridge for streaming to the dashboard. Pinned to the Jazzy base; apt gives the distro's released binaries.
FROM ros:jazzy-ros-base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ros-jazzy-ros2-control ros-jazzy-ros2-controllers ros-jazzy-controller-manager \
      ros-jazzy-robot-state-publisher ros-jazzy-xacro ros-jazzy-foxglove-bridge \
      ros-jazzy-teleop-twist-keyboard ros-jazzy-rosbag2-storage-mcap \
    && rm -rf /var/lib/apt/lists/*
