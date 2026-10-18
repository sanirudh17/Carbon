use super::*;

#[test]
fn legacy_index_migration_preserves_collected_clips_and_metadata_bumps_skip_fts() {
    let dir = std::env::temp_dir().join(format!("carbon_index_migration_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let path = dir.join("history.db");
    let db = DbState::new(path.clone()).unwrap();
    let mut clip = fixture("legacy-code", "code", "# Notes\nThe project is ready for the team.");
    db.insert_entry(&mut clip).unwrap();
    let collection = db.create_collection("Keep this".into(), None, None).unwrap();
    db.add_clip_to_collection(&clip.id, &collection.id).unwrap();
    let mut backup = db.export_backup().unwrap();
    db.set_collection_pin(&collection.id, "1234").unwrap();
    {
        let conn = db.conn.lock().unwrap();
        // Old FTS rows acquired unrelated rowids after duplicate bumps.
        conn.execute_batch("DROP TRIGGER entries_ai;
            CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
                INSERT INTO entries_fts(id,title,text_content,file_paths)
                VALUES(new.id,new.title,new.text_content,new.file_paths); END;
            DELETE FROM entries_fts;
            INSERT INTO entries_fts(rowid,id,title,text_content,file_paths)
                SELECT 999,id,title,text_content,file_paths FROM entries;").unwrap();
    }
    drop(db);
    let db = DbState::new(path).unwrap();
    let restored = db.get_entry_by_id("legacy-code").unwrap().unwrap();
    assert_eq!(restored.text_content, clip.text_content, "repair must never discard the capture");
    assert_eq!(restored.content_type, "text", "legacy classification is corrected in place");
    assert_eq!(db.get_clip_collection_ids("legacy-code").unwrap(), vec![collection.id.clone()]);
    assert!(db.get_all_entries(Some("project"), None, false, None).unwrap().is_empty());
    assert_eq!(db.get_all_entries(Some("project"), None, false, Some(&collection.id)).unwrap().len(), 1);
    let before = db.conn.lock().unwrap().query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0)).unwrap();
    db.bump_entry("legacy-code").unwrap();
    let conn = db.conn.lock().unwrap();
    assert_eq!(conn.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0)).unwrap() - before, 1, "metadata bump must not rebuild search content");
    let aligned: bool = conn.query_row("SELECT e.rowid=f.rowid FROM entries e JOIN entries_fts f ON f.id=e.id", [], |r| r.get(0)).unwrap();
    assert!(aligned);
    drop(conn);
    db.update_entry_text("legacy-code", "A brandnewword").unwrap();
    assert_eq!(db.get_all_entries(Some("brandnewword"), None, false, Some(&collection.id)).unwrap().len(), 1);
    backup.entries[0].text_content = Some("replacementword".into());
    backup.entries[0].title = "Replacement".into();
    backup.entries[0].content_type = "text".into();
    db.import_backup(backup, &dir.join("media")).unwrap();
    assert_eq!(db.get_clip_collection_ids("legacy-code").unwrap(), vec![collection.id.clone()], "restoring an existing clip must preserve collection membership");
    assert!(db.get_all_entries(Some("brandnewword"), None, false, Some(&collection.id)).unwrap().is_empty());
    assert_eq!(db.get_all_entries(Some("replacementword"), None, false, Some(&collection.id)).unwrap().len(), 1);
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT count(*) FROM entries_fts", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    db.delete_entry("legacy-code").unwrap();
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT count(*) FROM entries_fts", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    drop(db);
    fs::remove_dir_all(dir).unwrap();
}

fn fixture(id: &str, kind: &str, text: &str) -> ClipItem {
    ClipItem {
        id: id.into(),
        content_type: kind.into(),
        title: "Unrelated heading".into(),
        text_content: Some(text.into()),
        rtf_content: None,
        html_content: None,
        image_path: None,
        image_width: None,
        image_height: None,
        file_paths: None,
        is_video: false,
        file_size: text.len() as u64,
        is_pinned: false,
        source_app: Some("validation.exe".into()),
        created_at: String::new(),
        updated_at: String::new(),
        qr_content: None,
        is_sensitive: false,
        expires_at: None,
        ocr_text: None,
    }
}

#[test]
fn content_search_covers_types_literals_filters_and_index_updates() {
    let dir = std::env::temp_dir().join(format!(
        "carbon_search_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let path = dir.join("search.db");
    let db = DbState::new(path.clone()).unwrap();
    for (id, kind, body) in [
        ("plain", "text", "Meeting notes\nThe quasar engine is ready"),
        (
            "code",
            "code",
            "fn quasar_compute_index() { /* 100% capacity */ }",
        ),
        ("markdown", "text", "# Weekly report\n**quasar** roadmap"),
        ("rich", "rich_text", "A formatted quasar paragraph"),
        ("link", "link", "https://example.com/quasar/docs"),
        ("email", "email", "quasar@example.com"),
        ("unicode", "text", "A CAFÉ with தமிழ் content"),
        ("color", "color", "#123456"),
    ] {
        db.insert_entry(&mut fixture(id, kind, body)).unwrap();
    }
    let mut file = fixture("file", "file", "");
    file.file_paths = Some("C:\\work\\quasar_notes.txt".into());
    db.insert_entry(&mut file).unwrap();
    let mut image = fixture("image", "image", "quasar");
    image.ocr_text = Some("quasar engine".into());
    db.insert_entry(&mut image).unwrap();

    let search = |q: &str| db.get_all_entries(Some(q), None, false, None).unwrap();
    assert_eq!(
        search("qUaSaR").len(),
        7,
        "body matches across every text-bearing type, never images"
    );
    assert_eq!(
        db.get_today_entries(Some("quasar"), None, None)
            .unwrap()
            .len(),
        7
    );
    assert_eq!(
        search("engine quasar")[0].id,
        "plain",
        "words can appear in either order"
    );
    assert_eq!(
        search("compute")[0].id,
        "code",
        "code identifier components are searchable"
    );
    assert_eq!(search("_index")[0].id, "code", "underscore is literal");
    assert_eq!(search("100%")[0].id, "code", "percent is literal");
    assert!(search("missing_").is_empty());
    assert!(search("' OR 1=1 --").is_empty());
    assert_eq!(
        search("cafe")[0].id,
        "unicode",
        "Unicode FTS removes diacritics"
    );
    assert_eq!(search("தமிழ்")[0].id, "unicode");
    assert_eq!(search("#1234")[0].id, "color");
    assert_eq!(
        search("   ").len(),
        10,
        "clearing the search restores images"
    );
    assert_eq!(
        db.get_all_entries(Some("quasar"), Some("code"), false, None)
            .unwrap()[0]
            .id,
        "code"
    );

    db.toggle_pin("plain").unwrap();
    assert_eq!(
        db.get_all_entries(Some("quasar"), None, true, None)
            .unwrap()
            .len(),
        1
    );
    let collection = db.create_collection("Private".into(), None, None).unwrap();
    db.add_clip_to_collection("plain", &collection.id).unwrap();
    assert!(!search("quasar").iter().any(|clip| clip.id == "plain"),
        "even unlocked collection items stay out of global search");
    assert!(db.get_all_entries(None, None, false, None).unwrap().iter().any(|clip| clip.id == "plain"),
        "search privacy must not remove unlocked items from normal history");
    db.set_collection_pin(&collection.id, "1234").unwrap();
    assert!(!search("quasar").iter().any(|clip| clip.id == "plain"));
    assert_eq!(
        db.get_all_entries(Some("quasar"), None, false, Some(&collection.id))
            .unwrap()
            .len(),
        1
    );

    db.update_entry_text("markdown", "Edited with a fresh nebulaword")
        .unwrap();
    assert_eq!(search("nebulaword")[0].id, "markdown");
    assert!(!search("quasar").iter().any(|clip| clip.id == "markdown"));
    db.delete_entry("markdown").unwrap();
    assert!(search("nebulaword").is_empty());

    // Simulate a history written before index triggers existed.
    db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM entries_fts WHERE id = 'unicode'", [])
        .unwrap();
    drop(db);
    let reopened = DbState::new(path).unwrap();
    assert_eq!(
        reopened
            .get_all_entries(Some("cafe"), None, false, None)
            .unwrap()[0]
            .id,
        "unicode"
    );
    drop(reopened);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn content_search_large_history_latency() {
    let dir = std::env::temp_dir().join(format!(
        "carbon_search_perf_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let db = DbState::new(dir.join("search.db")).unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("BEGIN").unwrap();
        for n in 0..5000 {
            conn.execute("INSERT INTO entries(id, content_type, title, text_content, file_size, created_at, updated_at) VALUES (?1, 'code', 'Snippet', ?2, length(?2), datetime('now','localtime'), datetime('now','localtime'))", params![format!("perf-{n}"), format!("fn calculate_{n}() {{ // search performance benchmark }}")]).unwrap();
        }
        conn.execute_batch("COMMIT").unwrap();
    }
    let start = std::time::Instant::now();
    let found = db
        .get_all_entries(Some("calculate_4999 benchmark"), None, false, None)
        .unwrap();
    let elapsed = start.elapsed();
    assert_eq!(found.len(), 1);
    eprintln!("Content search over 5000 code clips: {elapsed:?}");
    assert!(elapsed < std::time::Duration::from_secs(1));
    let start = std::time::Instant::now();
    let first_page = db.get_all_entries_limited(Some("benchmark"), None, false, None, Some(201)).unwrap();
    assert_eq!(first_page.len(), 201, "broad matches have a bounded interactive payload");
    assert!(start.elapsed() < std::time::Duration::from_secs(1));
    drop(db);
    fs::remove_dir_all(dir).unwrap();
}
