//! Extraction of the shared JavaScript probe from its single source file
//! (packages/core/browser/probe.js). The file is an ES module whose export
//! is `PROBE_SOURCE = String.raw\`...\`` — the raw template text IS the
//! injected script (String.raw keeps backslashes verbatim). Both hosts
//! embed the file with include_str! and call [`extract`].

/// The probe file itself, embedded (single source of truth).
pub const PROBE_FILE: &str = include_str!("../../core/browser/probe.js");

/// The opening marker of the template literal export.
const OPEN_MARKER: &str = "String.raw`";

/// Extract the probe script from [`PROBE_FILE`]. The result is exactly
/// what the Deno side exports as PROBE_SOURCE (verified by the Deno test
/// suite in packages/core/browser/probe_test.ts and by the unit tests
/// here).
pub fn extract() -> Result<&'static str, String> {
    let start = PROBE_FILE
        .find(OPEN_MARKER)
        .ok_or_else(|| "probe.js must contain the String.raw export".to_string())?;
    let content_start = start + OPEN_MARKER.len();
    let end = PROBE_FILE[content_start..]
        .find('`')
        .ok_or_else(|| "probe.js String.raw export must be closed by a backtick".to_string())?
        + content_start;
    let probe = &PROBE_FILE[content_start..end];
    if probe.trim().is_empty() {
        return Err("probe.js String.raw export is empty".to_string());
    }
    Ok(probe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extraction_finds_the_probe() {
        let probe = extract().expect("extraction must succeed");
        assert!(
            probe.contains("window.__lumiscaProbe"),
            "probe must install the API"
        );
        assert!(probe.contains("unhandledrejection"));
        assert!(probe.contains("MutationObserver"));
        assert!(probe.contains("ref_not_found"));
        assert!(probe.contains("requestSubmit"));
        // The probe is an install-guarded IIFE (the extracted text starts
        // with a newline — the template literal opens on its own line).
        assert!(probe.trim_start().starts_with("(function () {"));
        assert!(probe.trim_end().ends_with("})();"));
    }

    #[test]
    fn probe_is_a_single_install_script() {
        // The injected script must never contain backticks (the template
        // literal would have ended) and never evaluate `${` (interpolation
        // would have silently corrupted it). The Deno test enforces the
        // same invariants on the exported string.
        let probe = extract().expect("extraction must succeed");
        assert!(!probe.contains('`'), "probe must not contain backticks");
        assert!(!probe.contains("${"), "probe must not contain ${{");
    }

    #[test]
    fn probe_size_is_bounded_for_injection() {
        // Eval of a multi-hundred-KB script is slow on every platform; the
        // probe must stay small.
        let probe = extract().expect("extraction must succeed");
        assert!(probe.len() < 64 * 1024, "probe too large: {}", probe.len());
    }
}
