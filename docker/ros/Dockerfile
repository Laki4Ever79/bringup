# Bringup's ROS 2 test image (docs/ros.md): Jazzy with ros2_control, the standard controllers, robot_state_publisher,
# foxglove_bridge for streaming to the dashboard, and the Nav2 servers the robot's navigation launch starts (step 2).
# Pinned to the Jazzy base; apt gives the distro's released binaries.
FROM ros:jazzy-ros-base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ros-jazzy-ros2-control ros-jazzy-ros2-controllers ros-jazzy-controller-manager \
      ros-jazzy-robot-state-publisher ros-jazzy-xacro ros-jazzy-foxglove-bridge \
      ros-jazzy-teleop-twist-keyboard ros-jazzy-rosbag2-storage-mcap ros-jazzy-rosbridge-server \
      ros-jazzy-nav2-controller ros-jazzy-nav2-planner ros-jazzy-nav2-behaviors ros-jazzy-nav2-bt-navigator \
      ros-jazzy-nav2-lifecycle-manager ros-jazzy-nav2-map-server ros-jazzy-nav2-navfn-planner \
      ros-jazzy-nav2-regulated-pure-pursuit-controller ros-jazzy-nav2-msgs \
    && rm -rf /var/lib/apt/lists/*
