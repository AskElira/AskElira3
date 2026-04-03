const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const SETTINGS_PATH = path.resolve(__dirname, '..', 'data', 'settings.json');

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    _cache = { notifications: { floorLive: false, floorBlocked: false, buildComplete: true, stevenAlerts: false } };
  }
  return _cache;
}

function save(data) {
  _cache = data;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

function get() {
  return load();
}

function update(patch) {
  const s = load();
  const updated = { ...s, ...patch };
  // Deep merge notifications
  if (patch.notifications) {
    updated.notifications = { ...s.notifications, ...patch.notifications };
  }
  save(updated);
  return updated;
}

module.exports = { get, update };
