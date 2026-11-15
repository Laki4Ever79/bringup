// The host's stand-in for Wire.h: an I2C bus with simulated chips on it. A chip sees each write the controller ends
// and answers each read, with the fake clock's time, so it can refuse a read that comes before its measurement is done
// (a real Sensirion chip NACKs it).
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <map>
#include <vector>
#include "Arduino.h"

struct HostChip {
	virtual ~HostChip() {}
	virtual bool onWrite(const std::vector<uint8_t> &bytes, uint64_t nowUs) = 0;  // false: NACK
	virtual bool onRead(size_t n, uint64_t nowUs, std::vector<uint8_t> &out) = 0;  // false: NACK
};

class HostWire {
public:
	std::map<uint8_t, HostChip *> chips;
	std::vector<std::pair<uint8_t, std::vector<uint8_t>>> writes;  // every write, in order: address, bytes
	void begin() {}
	void begin(int, int) {}
	void beginTransmission(uint8_t addr) {
		addr_ = addr;
		tx_.clear();
	}
	size_t write(uint8_t b) {
		tx_.push_back(b);
		return 1;
	}
	uint8_t endTransmission(bool = true) {
		writes.push_back({addr_, tx_});
		auto it = chips.find(addr_);
		if (it == chips.end()) return 2;  // address NACK
		return it->second->onWrite(tx_, host::nowUs()) ? 0 : 3;
	}
	uint8_t requestFrom(uint8_t addr, uint8_t n) {
		rx_.clear();
		pos_ = 0;
		auto it = chips.find(addr);
		if (it == chips.end() || !it->second->onRead(n, host::nowUs(), rx_)) return 0;
		return (uint8_t)rx_.size();
	}
	uint8_t requestFrom(int addr, int n) { return requestFrom((uint8_t)addr, (uint8_t)n); }
	int read() { return pos_ < rx_.size() ? rx_[pos_++] : -1; }
	void reset() {
		chips.clear();
		writes.clear();
	}

private:
	uint8_t addr_ = 0;
	std::vector<uint8_t> tx_, rx_;
	size_t pos_ = 0;
};
inline HostWire Wire;
