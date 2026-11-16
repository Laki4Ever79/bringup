// No ROS container outlives its run (src/ros/run.ts): each docker run gets a name, a short stop timeout and a timeout
// inside the container, so it ends itself even when the process that started it is killed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { containerArgs, ROS_IMAGE } from "../src/ros/run.ts"

test("a docker run is named and ends itself inside the container when its time is up", () => {
	const args = ["run", "--rm", "--network", "host", "-v", "/a:/out", ROS_IMAGE, "bash", "-c", "ros2 launch x"]
	assert.deepEqual(containerArgs(args, 600_000, "bringup-ros-1-abc"), ["run", "--name", "bringup-ros-1-abc", "--stop-timeout", "5", "--rm", "--network", "host", "-v", "/a:/out", ROS_IMAGE, "timeout", "-k", "10", "600", "bash", "-c", "ros2 launch x"])
	assert.deepEqual(containerArgs(["run", "--rm", ROS_IMAGE, "true"], 1500, "n").slice(-5), ["timeout", "-k", "10", "2", "true"])
})

test("other docker commands are left as they are", () => {
	assert.deepEqual(containerArgs(["image", "inspect", ROS_IMAGE], 1000, "n"), ["image", "inspect", ROS_IMAGE])
	assert.deepEqual(containerArgs(["run", "--rm", "other:image", "true"], 1000, "n"), ["run", "--rm", "other:image", "true"])
})
