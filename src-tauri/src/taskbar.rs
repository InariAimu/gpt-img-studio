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

    #[cfg(any(target_os = "macos", test))]
    fn dock_badge(&self) -> Option<String> {
        let running = self
            .jobs
            .values()
            .filter(|status| *status == "running")
            .count();
        let marker = if self.unseen_failure {
            "!"
        } else if self.attention {
            "✓"
        } else {
            ""
        };
        if running > 0 {
            Some(format!("{running}{marker}"))
        } else {
            (!marker.is_empty()).then(|| marker.to_owned())
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
mod native {
    use super::*;
    use std::sync::Mutex;
    #[cfg(windows)]
    use tauri::{
        window::{ProgressBarState, ProgressBarStatus},
        UserAttentionType,
    };
    use tauri::{AppHandle, Manager, WebviewWindow};

    #[derive(Default)]
    pub struct Taskbar(Mutex<Tracker>);

    #[cfg(windows)]
    fn apply(window: &WebviewWindow, effects: Effects) {
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
    fn update_on_main(
        app: &AppHandle,
        update: impl FnOnce(&WebviewWindow, &mut Tracker) -> Effects + Send + 'static,
    ) {
        let handle = app.clone();
        // Serialize native effects on the UI thread. Never hold the tracker lock across window calls.
        let _ = app.run_on_main_thread(move || {
            let Some(window) = handle.get_webview_window("main") else {
                return;
            };
            let Some(state) = handle.try_state::<Taskbar>() else {
                return;
            };
            let Ok(mut tracker) = state.0.lock() else {
                return;
            };
            #[cfg(target_os = "macos")]
            let previous = tracker.revision.map(|_| tracker.dock_badge());
            let effects = update(&window, &mut tracker);
            #[cfg(target_os = "macos")]
            let badge = tracker.dock_badge();
            drop(tracker);
            #[cfg(windows)]
            apply(&window, effects);
            #[cfg(target_os = "macos")]
            {
                let _ = effects;
                if previous.as_ref() != Some(&badge) {
                    let _ = window.set_badge_label(badge);
                }
            }
        });
    }

    pub fn sync(app: &AppHandle, document: &Value) {
        let snapshot = Snapshot::from_document(document);
        update_on_main(app, move |window, tracker| {
            let focused =
                window.is_focused().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
            tracker.update(snapshot, focused)
        });
    }

    pub fn focus(app: &AppHandle) {
        update_on_main(app, |window, tracker| {
            // A queued focus event may be stale after a rapid switch to another app.
            if !window.is_focused().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
                return Effects::default();
            }
            tracker.focused()
        });
    }
}

pub fn initialize(app: &tauri::AppHandle, document: &Value) {
    #[cfg(any(windows, target_os = "macos"))]
    {
        use tauri::Manager;
        app.manage(native::Taskbar::default());
        native::sync(app, document);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (app, document);
}
pub fn sync(app: &tauri::AppHandle, document: &Value) {
    #[cfg(any(windows, target_os = "macos"))]
    native::sync(app, document);
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (app, document);
}
pub fn focused(app: &tauri::AppHandle) {
    #[cfg(any(windows, target_os = "macos"))]
    native::focus(app);
    #[cfg(not(any(windows, target_os = "macos")))]
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

    #[test]
    fn dock_badge_keeps_the_running_count_next_to_an_unread_result() {
        let mut tracker = Tracker::default();
        tracker.update(snapshot(0, &[]), false);
        assert_eq!(tracker.dock_badge(), None);
        tracker.update(snapshot(1, &[("a", "running"), ("b", "running")]), false);
        assert_eq!(tracker.dock_badge().as_deref(), Some("2"));
        tracker.update(snapshot(2, &[("a", "completed"), ("b", "running")]), false);
        assert_eq!(tracker.dock_badge().as_deref(), Some("1✓"));
        tracker.focused();
        assert_eq!(tracker.dock_badge().as_deref(), Some("1"));
        tracker.update(
            snapshot(3, &[("a", "completed"), ("b", "completed")]),
            false,
        );
        assert_eq!(tracker.dock_badge().as_deref(), Some("✓"));
        tracker.focused();
        assert_eq!(tracker.dock_badge(), None);
    }

    #[test]
    fn dock_badge_prioritizes_failures_and_only_marks_background_results() {
        let mut tracker = Tracker::default();
        tracker.update(
            snapshot(5, &[("old", "failed"), ("cancelled", "interrupted")]),
            false,
        );
        assert_eq!(tracker.dock_badge(), None);
        tracker.update(snapshot(6, &[("a", "running"), ("b", "running")]), true);
        tracker.update(snapshot(7, &[("a", "failed"), ("b", "running")]), false);
        assert_eq!(tracker.dock_badge().as_deref(), Some("1!"));
        tracker.update(snapshot(8, &[("a", "failed"), ("b", "completed")]), false);
        assert_eq!(tracker.dock_badge().as_deref(), Some("!"));
        tracker.update(snapshot(7, &[("a", "running"), ("b", "running")]), true);
        assert_eq!(tracker.dock_badge().as_deref(), Some("!"));
        tracker.focused();
        assert_eq!(tracker.dock_badge(), None);
        tracker.update(snapshot(9, &[("c", "running")]), true);
        tracker.update(snapshot(10, &[("c", "completed")]), true);
        assert_eq!(tracker.dock_badge(), None);
    }
}
