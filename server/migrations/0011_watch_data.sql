-- Garmin watch data imported from the watch's own FIT files (USB or Bluetooth).
-- Every write is an idempotent upsert keyed by device and time, so a file the
-- watch rewrote (today's monitoring file grows all day) can be imported again.
CREATE TABLE IF NOT EXISTS watch_devices (
    serial TEXT PRIMARY KEY,
    product TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    first_seen_at INTEGER NOT NULL,
    last_import_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watch_files (
    sha256 TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    serial TEXT,
    kind TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    error TEXT
);
-- One value per device, watch-local day and metric (resting_hr, vo2max);
-- `at` keeps the newest observation when files arrive out of order.
CREATE TABLE IF NOT EXISTS watch_daily (
    serial TEXT NOT NULL,
    day TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (serial, day, metric)
);
-- The watch counts steps cumulatively per activity type from local midnight.
CREATE TABLE IF NOT EXISTS watch_steps (
    serial TEXT NOT NULL,
    day TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    steps INTEGER NOT NULL,
    PRIMARY KEY (serial, day, activity_type)
);
CREATE TABLE IF NOT EXISTS watch_samples (
    serial TEXT NOT NULL,
    time INTEGER NOT NULL,
    day TEXT NOT NULL,
    heart_rate INTEGER,
    stress INTEGER,
    PRIMARY KEY (serial, time)
);
CREATE INDEX IF NOT EXISTS watch_samples_day ON watch_samples(serial, day);
CREATE TABLE IF NOT EXISTS watch_activities (
    serial TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    sport TEXT NOT NULL,
    sub_sport TEXT,
    name TEXT,
    duration_s REAL,
    distance_m REAL,
    calories INTEGER,
    avg_hr INTEGER,
    max_hr INTEGER,
    PRIMARY KEY (serial, start_time)
);
