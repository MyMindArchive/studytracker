use std::path::PathBuf;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{Connection, Executor};

/// One parameterised statement inside a batch.
#[derive(serde::Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<serde_json::Value>,
}

/// Runs every statement in a single transaction on ONE connection.
///
/// The SQL plugin's `execute` goes through a connection pool, so an explicit
/// BEGIN/COMMIT pair issued from the front end may land on different
/// connections and leave a write transaction open. All multi-statement
/// writes therefore go through this command instead.
#[tauri::command]
async fn sql_batch(db_path: String, statements: Vec<Statement>) -> Result<u64, String> {
    let mut conn = sqlx::SqliteConnection::connect_with(&connect_opts(&db_path, true)?)
        .await
        .map_err(|e| e.to_string())?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let mut affected = 0u64;
    for st in &statements {
        let mut q = sqlx::query(&st.sql);
        for p in &st.params {
            q = match p {
                serde_json::Value::Null => q.bind(Option::<String>::None),
                serde_json::Value::Bool(b) => q.bind(*b as i64),
                serde_json::Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        q.bind(i)
                    } else {
                        q.bind(n.as_f64().unwrap_or(0.0))
                    }
                }
                serde_json::Value::String(s) => q.bind(s.clone()),
                other => q.bind(other.to_string()),
            };
        }
        let r = tx
            .execute(q)
            .await
            .map_err(|e| format!("{e} — in: {}", st.sql.chars().take(120).collect::<String>()))?;
        affected += r.rows_affected();
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(affected)
}

/// Returns the user's home directory as a string so the front end can build
/// the default storage path (~/StudyTracker) before the SQL plugin is loaded.
#[tauri::command]
fn home_dir() -> Result<String, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| e.to_string())
}

/// Opens `db_path` read-write (never creating it) with the same options the
/// front end uses, so helper commands see committed WAL data.
fn connect_opts(db_path: &str, create: bool) -> Result<SqliteConnectOptions, String> {
    Ok(SqliteConnectOptions::from_str(&format!("sqlite:{db_path}"))
        .map_err(|e| e.to_string())?
        .create_if_missing(create)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5)))
}

/// Writes a consistent snapshot of the database to `target` using SQLite's
/// `VACUUM INTO`. A plain file copy would miss every transaction still in the
/// WAL journal and could tear a page mid-write; this sees committed data only.
async fn snapshot_database(db_path: &str, target: &std::path::Path) -> Result<(), String> {
    let mut conn = sqlx::SqliteConnection::connect_with(&connect_opts(db_path, false)?)
        .await
        .map_err(|e| e.to_string())?;
    let target_str = target.to_string_lossy().to_string();
    sqlx::query("VACUUM INTO ?")
        .bind(target_str)
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    // Fold the WAL back into the main file while we are here so the folder the
    // user copies around is (nearly) always just studytracker.db.
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&mut conn).await;
    let _ = conn.close().await;
    Ok(())
}

/// Copies the SQLite database to a timestamped backup and prunes to `keep`
/// copies. One backup per UTC day; later calls the same day only prune.
#[tauri::command]
async fn backup_database(db_path: String, keep: usize) -> Result<Option<String>, String> {
    let src = PathBuf::from(&db_path);
    if !src.exists() {
        return Ok(None);
    }
    let dir = src
        .parent()
        .ok_or("database has no parent directory")?
        .join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let today = chrono_free_date();
    let target = dir.join(format!("studytracker-{today}.db"));
    if target.exists() {
        prune_backups(&dir, keep)?;
        return Ok(None);
    }
    // VACUUM INTO refuses to overwrite; write to a temp name and rename so a
    // half-written backup never carries the final name.
    let tmp = dir.join(format!("studytracker-{today}.db.partial"));
    let _ = std::fs::remove_file(&tmp);
    snapshot_database(&db_path, &tmp).await?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    prune_backups(&dir, keep)?;
    Ok(Some(target.to_string_lossy().to_string()))
}

/// Copies the live database to a new location (used when the user changes the
/// storage folder). Refuses to overwrite an existing file.
#[tauri::command]
async fn copy_database(src_path: String, dst_path: String) -> Result<(), String> {
    let dst = PathBuf::from(&dst_path);
    if dst.exists() {
        return Err(format!("{dst_path} already exists"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !PathBuf::from(&src_path).exists() {
        return Err(format!("{src_path} does not exist"));
    }
    snapshot_database(&src_path, &dst).await
}

fn prune_backups(dir: &PathBuf, keep: usize) -> Result<(), String> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("studytracker-") && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();
    entries.sort();
    while entries.len() > keep {
        let oldest = entries.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
    Ok(())
}

/// YYYY-MM-DD for local "today" without pulling in chrono. Uses UTC offset from
/// the system via libc-free arithmetic on SystemTime; local offset is applied
/// by the front end when it decides *whether* to back up, so UTC here is fine.
fn chrono_free_date() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    // Civil-from-days algorithm (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![home_dir, backup_database, copy_database, sql_batch])
        .run(tauri::generate_context!())
        .expect("error while running StudyTracker");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_is_atomic_and_binds_all_json_types() {
        let dir = std::env::temp_dir().join(format!("st-batch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db").to_string_lossy().to_string();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let st = |sql: &str, params: Vec<serde_json::Value>| Statement { sql: sql.to_string(), params };

        rt.block_on(async {
            sql_batch(
                db.clone(),
                vec![st("CREATE TABLE t (id TEXT PRIMARY KEY, n REAL, i INTEGER, s TEXT NULL)", vec![])],
            )
            .await
            .unwrap();
            let n = sql_batch(
                db.clone(),
                vec![
                    st("INSERT INTO t VALUES (?,?,?,?)", vec!["a".into(), 1.5.into(), 7.into(), serde_json::Value::Null]),
                    st("INSERT INTO t VALUES (?,?,?,?)", vec!["b".into(), 2.into(), true.into(), "x".into()]),
                ],
            )
            .await
            .unwrap();
            assert_eq!(n, 2);
            // second statement fails -> first must be rolled back
            let err = sql_batch(
                db.clone(),
                vec![
                    st("INSERT INTO t VALUES ('c', 0, 0, NULL)", vec![]),
                    st("INSERT INTO t VALUES ('a', 0, 0, NULL)", vec![]),
                ],
            )
            .await;
            assert!(err.is_err());
            let opts = SqliteConnectOptions::from_str(&format!("sqlite:{db}")).unwrap();
            let mut conn = sqlx::SqliteConnection::connect_with(&opts).await.unwrap();
            let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM t").fetch_one(&mut conn).await.unwrap();
            assert_eq!(row.0, 2, "failed batch left no partial rows");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn date_is_iso_and_plausible() {
        let d = chrono_free_date();
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert!(d.starts_with("20"));
    }

    #[test]
    fn backup_creates_once_per_day_and_prunes() {
        let dir = std::env::temp_dir().join(format!("st-backup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("studytracker.db").to_string_lossy().to_string();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let st = |sql: &str| Statement { sql: sql.to_string(), params: vec![] };
        rt.block_on(async {
            sql_batch(db.clone(), vec![st("CREATE TABLE t (id INTEGER PRIMARY KEY)"), st("INSERT INTO t VALUES (1), (2), (3)")])
                .await
                .unwrap();
        });
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        for i in 0..9 {
            std::fs::write(backups.join(format!("studytracker-2000-01-0{i}.db")), b"old").unwrap();
        }
        let first = rt.block_on(backup_database(db.clone(), 7)).unwrap();
        assert!(first.is_some(), "first call of the day writes a backup");
        let second = rt.block_on(backup_database(db.clone(), 7)).unwrap();
        assert!(second.is_none(), "second call the same day is a no-op");
        let count = std::fs::read_dir(&backups).unwrap().count();
        assert_eq!(count, 7, "pruned to the newest seven");
        let first = first.unwrap();
        assert!(std::path::Path::new(&first).exists());
        // the backup is a real, consistent database that includes WAL content
        rt.block_on(async {
            let opts = SqliteConnectOptions::from_str(&format!("sqlite:{first}")).unwrap();
            let mut conn = sqlx::SqliteConnection::connect_with(&opts).await.unwrap();
            let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM t").fetch_one(&mut conn).await.unwrap();
            assert_eq!(row.0, 3);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_database_refuses_to_overwrite() {
        let dir = std::env::temp_dir().join(format!("st-copy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a").join("studytracker.db").to_string_lossy().to_string();
        let dst = dir.join("b").join("studytracker.db").to_string_lossy().to_string();
        let rt = tokio::runtime::Runtime::new().unwrap();
        std::fs::create_dir_all(dir.join("a")).unwrap();
        rt.block_on(async {
            sql_batch(src.clone(), vec![Statement { sql: "CREATE TABLE t (id INTEGER)".into(), params: vec![] }])
                .await
                .unwrap();
            copy_database(src.clone(), dst.clone()).await.unwrap();
            assert!(std::path::Path::new(&dst).exists());
            assert!(copy_database(src.clone(), dst.clone()).await.is_err(), "second copy must not overwrite");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
