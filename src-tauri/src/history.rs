use crate::db::DbState;
use crate::settings::SettingsState;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub struct HistoryManager;

impl HistoryManager {
    pub fn start_cleanup_task(db_state: Arc<DbState>, settings_state: Arc<SettingsState>) {
        thread::spawn(move || loop {
            let settings = settings_state.get();
            let _ = db_state.trim_history(settings.retention_days, settings.max_entries);
            thread::sleep(Duration::from_secs(3600)); // Run hourly
        });
    }
}
