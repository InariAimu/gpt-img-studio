use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
struct Tracker {
    revision: Option<u64>,
    jobs: HashMap<String, String>,
    attention: bool,
    unseen_failure: bool,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Progress {
    Idle,
    Running,
    Error,
}
#[derive(Default, Debug, PartialEq)]
struct Effects {
    progress: Option<Progress>,
    attention: Option<bool>,
}
struct Snapshot {
    revision: u64,
    jobs: HashMap<String, String>,
}
impl Snapshot {
    fn from_document(document: &Value) -> Self {
        Self {
            revision: document["revision"].as_u64().unwrap_or(0),
            jobs: document["jobs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|job| {
                    Some((
                        job["id"].as_str()?.to_owned(),
                        job["status"].as_str()?.to_owned(),
                    ))
                })
                .collect(),
        }
    }
}
impl Tracker {
    fn progress(&self) -> Progress {
        if self.unseen_failure {
            Progress::Error
        } else if self.jobs.values().any(|status| status == "running") {
            Progress::Running
        } else {
            Progress::Idle
        }
    }

    fn update(&mut self, next: Snapshot, focused: bool) -> Effects {
        if self
            .revision
            .is_some_and(|revision| next.revision <= revision)
        {
            return Effects::default();
        }
        let initial = self.revision.is_none();
        let previous_progress = self.progress();
        let mut finished = false;
        let mut failed = false;
        for (id, status) in &next.jobs {
            if self
                .jobs
                .get(id)
                .is_some_and(|previous| previous == "running")
            {
                finished |= matches!(status.as_str(), "completed" | "failed");
                failed |= status == "failed";
            }
        }
        self.unseen_failure = !focused && (self.unseen_failure || failed);
        self.jobs = next.jobs;
        self.revision = Some(next.revision);
        let progress = self.progress();
        let mut effects = Effects {
            progress: (initial || previous_progress != progress).then_some(progress),
            attention: None,
        };
        if initial || focused && self.attention {
            self.attention = false;
            effects.attention = Some(false);
        } else if finished && !focused && !self.attention {
            self.attention = true;
            effects.attention = Some(true);
        }
        effects
    }
    fn focused(&mut self) -> Effects {
        self.attention = false;
        let was_failed = std::mem::take(&mut self.unseen_failure);
        Effects {
            progress: was_failed.then(|| self.progress()),
            attention: Some(false),
        }
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::Mutex;
    use tauri::{
        window::{ProgressBarState, ProgressBarStatus},
        AppHandle, Manager, UserAttentionType,
    };

    #[derive(Default)]
    pub struct Taskbar(Mutex<Tracker>);

    fn apply(app: &AppHandle, effects: Effects) {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let Some(progress) = effects.progress {
            let _ = window.set_progress_bar(ProgressBarState {
                status: Some(match progress {
                    Progress::Idle => ProgressBarStatus::None,
                    Progress::Running => ProgressBarStatus::Indeterminate,
                    Progress::Error => ProgressBarStatus::Error,
                }),
                progress: (progress == Progress::Error).then_some(100),
            });
        }
        if let Some(attention) = effects.attention {
            let _ = window
                .request_user_attention(attention.then_some(UserAttentionType::Informational));
        }
    }
    pub fn sync(app: &AppHandle, document: &Value) {
        let snapshot = Snapshot::from_document(document);
        let handle = app.clone();
        // Serialize native effects on the UI thread. Never hold the tracker lock across window calls.
        let _ = app.run_on_main_thread(move || {
            let Some(window) = handle.get_webview_window("main") else {
                return;
            };
            let focused =
                window.is_focused().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
            let Some(state) = handle.try_state::<Taskbar>() else {
                return;
            };
            let Ok(mut tracker) = state.0.lock() else {
                return;
            };
            let effects = tracker.update(snapshot, focused);
            drop(tracker);
            apply(&handle, effects);
        });
    }
    pub fn focus(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = handle.get_webview_window("main") else {
                return;
            };
            // A queued focus event may be stale after a rapid switch to another app.
            if !window.is_focused().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
                return;
            }
            let Some(state) = handle.try_state::<Taskbar>() else {
                return;
            };
            let Ok(mut tracker) = state.0.lock() else {
                return;
            };
            let effects = tracker.focused();
            drop(tracker);
            apply(&handle, effects);
        });
    }
}

pub fn initialize(app: &tauri::AppHandle, document: &Value) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        app.manage(native::Taskbar::default());
        native::sync(app, document);
    }
    #[cfg(not(windows))]
    let _ = (app, document);
}
pub fn sync(app: &tauri::AppHandle, document: &Value) {
    #[cfg(windows)]
    native::sync(app, document);
    #[cfg(not(windows))]
    let _ = (app, document);
}
pub fn focused(app: &tauri::AppHandle) {
    #[cfg(windows)]
    native::focus(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn snapshot(revision: u64, jobs: &[(&str, &str)]) -> Snapshot {
        Snapshot::from_document(
            &json!({"revision":revision,"jobs":jobs.iter().map(|(id,status)|json!({"id":id,"status":status})).collect::<Vec<_>>()}),
        )
    }
    #[test]
    fn concurrent_jobs_keep_animation_and_coalesce_background_notifications() {
        let mut tracker = Tracker::default();
        assert_eq!(
            tracker.update(snapshot(0, &[]), false),
            Effects {
                progress: Some(Progress::Idle),
                attention: Some(false)
            }
        );
        assert_eq!(
            tracker
                .update(snapshot(1, &[("a", "running"), ("b", "running")]), false)
                .progress,
            Some(Progress::Running)
        );
        assert_eq!(
            tracker.update(snapshot(2, &[("a", "completed"), ("b", "running")]), false),
            Effects {
                progress: None,
                attention: Some(true)
            }
        );
        assert_eq!(
            tracker.update(snapshot(3, &[("a", "completed"), ("b", "failed")]), false),
            Effects {
                progress: Some(Progress::Error),
                attention: None
            }
        );
        assert_eq!(
            tracker.focused(),
            Effects {
                progress: Some(Progress::Idle),
                attention: Some(false)
            }
        );
    }
    #[test]
    fn focused_completion_does_not_alert_and_focus_does_not_stop_other_jobs() {
        let mut tracker = Tracker::default();
        tracker.update(snapshot(1, &[("a", "running"), ("b", "running")]), true);
        assert_eq!(
            tracker.update(snapshot(2, &[("a", "completed"), ("b", "running")]), true),
            Effects::default()
        );
        assert_eq!(tracker.focused().progress, None);
        assert_eq!(
            tracker.update(snapshot(3, &[("a", "completed"), ("b", "failed")]), true),
            Effects {
                progress: Some(Progress::Idle),
                attention: None
            }
        );
    }
    #[test]
    fn background_failure_stays_red_until_focus_then_restores_remaining_progress() {
        let mut tracker = Tracker::default();
        tracker.update(snapshot(1, &[("a", "running"), ("b", "running")]), false);
        assert_eq!(
            tracker.update(snapshot(2, &[("a", "failed"), ("b", "running")]), false),
            Effects {
                progress: Some(Progress::Error),
                attention: Some(true)
            }
        );
        assert_eq!(
            tracker.update(snapshot(3, &[("b", "running"), ("c", "running")]), false),
            Effects::default()
        );
        assert_eq!(
            tracker.focused(),
            Effects {
                progress: Some(Progress::Running),
                attention: Some(false)
            }
        );
        assert_eq!(
            tracker
                .update(snapshot(4, &[("b", "completed"), ("c", "failed")]), true)
                .progress,
            Some(Progress::Idle)
        );
    }
    #[test]
    fn startup_and_stale_snapshots_never_replay_old_completions() {
        let mut tracker = Tracker::default();
        assert_eq!(
            tracker.update(
                snapshot(8, &[("old", "failed"), ("interrupted", "interrupted")]),
                false
            ),
            Effects {
                progress: Some(Progress::Idle),
                attention: Some(false)
            }
        );
        tracker.update(snapshot(10, &[("new", "running")]), false);
        assert_eq!(tracker.update(snapshot(9, &[]), false), Effects::default());
        assert_eq!(
            tracker
                .update(snapshot(11, &[("new", "completed")]), false)
                .attention,
            Some(true)
        );
        assert_eq!(
            tracker.update(snapshot(11, &[("new", "completed")]), false),
            Effects::default()
        );
    }
}
