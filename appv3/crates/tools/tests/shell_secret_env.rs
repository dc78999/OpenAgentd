//! Provider keys and other secrets the server loads from `.env` or saves
//! through the API live in the server's own environment. Commands the agent
//! runs must not inherit them: `printenv` would otherwise sidestep the
//! `**/.env` read block. Separate test binary: it mutates the environment.
#![cfg(unix)]

use appv3_tools::{shell::ShellTool, DeniedPaths, Tool, ToolContext, ToolOutput};
use std::sync::Arc;

#[tokio::test]
async fn agent_shell_does_not_inherit_server_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let env_file = dir.path().join(".env");
    std::fs::write(&env_file, "OAD_TEST_FILE_API_KEY=oad-file-canary\n").unwrap();
    appv3_core::env::load_env_file(&env_file);
    // A key saved through the provider settings API at runtime.
    appv3_core::env::mark_server_set("OAD_TEST_SAVED_API_KEY");
    std::env::set_var("OAD_TEST_SAVED_API_KEY", "oad-saved-canary");
    // Something the user exported before starting the server.
    std::env::set_var("OAD_TEST_USER_VAR", "oad-user-value");

    let ctx = ToolContext {
        session_id: None,
        agent_name: "t".into(),
        tool_call_id: "c".into(),
        denied: Arc::new(DeniedPaths::with(dir.path(), None, Some(vec![]), Some(vec![]))),
        workspace: None,
        output: None,
        metadata: Default::default(),
        messages: None,
    };
    let out = ShellTool.run(&ctx, serde_json::json!({"command": "env"})).await.unwrap();
    let ToolOutput::Text(text) = out else { panic!("unexpected output {out:?}") };
    assert!(text.contains("oad-user-value"), "user env must pass through: {text}");
    assert!(!text.contains("oad-file-canary"), ".env value reached the agent shell: {text}");
    assert!(!text.contains("oad-saved-canary"), "saved provider key reached the agent shell: {text}");
}
