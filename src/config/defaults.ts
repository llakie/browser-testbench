export class TestbenchDefaults {
  static readonly LOOPBACK_HOST = "127.0.0.1";
  static readonly ANDROID_EMULATOR_LOOPBACK_HOST = "10.0.2.2";
  static readonly PORT = 55_808;
  static readonly SERVER_URL = `http://${this.LOOPBACK_HOST}:${this.PORT}`;

  static readonly WAIT_TIMEOUT_MS = 15_000;
  static readonly NETWORK_IDLE_QUIET_MS = 500;
  static readonly INSPECTION_LIMIT = 100;
  static readonly INSPECTION_MAX = 500;
  static readonly INSPECTED_TEXT_MAX_LENGTH = 200;
  static readonly PAGE_SOURCE_LIMIT = 100_000;
  static readonly PAGE_SOURCE_MAX = 500_000;
  static readonly DIAGNOSTIC_EVENT_LIMIT = 500;
  static readonly DOWNLOAD_POLL_INTERVAL_MS = 100;
  static readonly TARGET_CACHE_TTL_MS = 30_000;
  static readonly ENVIRONMENT_POLL_INTERVAL_MS = 2_000;
  static readonly EVENT_HEARTBEAT_INTERVAL_MS = 15_000;
  static readonly PAIRING_TTL_MS = 5 * 60_000;
  static readonly PAIRING_MAX_PENDING = 20;
  static readonly REMOTE_REQUEST_MAX_AGE_MS = 30_000;
  static readonly REMOTE_CLIENT_TOUCH_INTERVAL_MS = 30_000;
  static readonly TARGET_LOCK_TIMEOUT_MS = 60_000;
  static readonly REMOTE_CLEANUP_TIMEOUT_MS = 10_000;
  static readonly REMOTE_CONNECT_TIMEOUT_MS = 10_000;
  static readonly REMOTE_REQUEST_TIMEOUT_MS = 120_000;
  static readonly MOBILE_SESSION_REQUEST_TIMEOUT_MS = 7 * 60_000;
  static readonly SETUP_REQUEST_TIMEOUT_MS = 11 * 60_000;
  static readonly REMOTE_HEARTBEAT_INTERVAL_MS = 30_000;
  static readonly REMOTE_LEASE_TIMEOUT_MS = 90_000;
  static readonly ANDROID_ADB_COMMAND_TIMEOUT_MS = 120_000;
  static readonly ANDROID_EMULATOR_PHASE_TIMEOUT_MS = 3 * 60_000;
  static readonly ANDROID_UIAUTOMATOR_INSTALL_TIMEOUT_MS = 120_000;
  static readonly SCREENSHOT_SCROLL_SETTLE_MS = 250;
  static readonly GESTURE_MAX_PERCENT = 0.99;
  static readonly SWIPE_PERCENT = 0.75;
  static readonly PINCH_PERCENT = 0.5;
}
