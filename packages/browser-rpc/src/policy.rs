//! URL policy for the browser lab — the HOST-side enforcement of
//! packages/core/browser/policy.ts (the Deno tools validate first; a host
//! must never open a URL the client was not allowed to pass. Defense in
//! depth, exact same rules).

/// Check the URL against the lab policy. Returns Ok when the URL may be
/// opened, Err(reason) otherwise. Same rules as the Deno side:
/// http/https on localhost / 127.0.0.1 / ::1 only; no credentials in the
/// URL; no other hosts, schemes or forms.
pub fn check(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL を解析できません: {url} ({e})"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "拒否: スキーム \"{scheme}\" は開けません (http/https のみ)"
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("拒否: URL に認証情報を含めることはできません".to_string());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&host);
    if host != "localhost"
        && host != "127.0.0.1"
        && host != "::1"
        && bare != "localhost"
        && bare != "127.0.0.1"
        && bare != "::1"
    {
        return Err(format!(
            "拒否: ローカルホスト (localhost / 127.0.0.1 / ::1) 以外の URL は開けません: {url}"
        ));
    }
    if parsed.port().is_none() && parsed.port_or_known_default().is_none() {
        return Err(format!("拒否: ポートが不正です: {url}"));
    }
    Ok(())
}

/// Check and normalize: returns the URL to hand to the webview (the
/// original, with the fragment preserved — hash-only navigation is part
/// of the page's own behavior).
pub fn require_allowed(url: &str) -> Result<&str, String> {
    check(url)?;
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_loopback_http_urls() {
        for url in [
            "http://127.0.0.1:5173/",
            "http://localhost:8000/?token=x",
            "http://[::1]:8080/",
            "https://localhost:8443/",
            "http://127.0.0.1/",
            "http://localhost:3000/app#section",
        ] {
            assert!(check(url).is_ok(), "{url} must be allowed");
        }
    }

    #[test]
    fn rejects_non_loopback_and_other_schemes() {
        for url in [
            "https://example.com/",
            "http://127.0.0.2:3000/",
            "http://localhost.evil.com/",
            "file:///etc/passwd",
            "data:text/html,<h1>x</h1>",
            "ftp://localhost/",
            "ws://localhost:3000/",
            "javascript:alert(1)",
            "http://user:pass@localhost:3000/",
            "about:blank",
            "not a url",
        ] {
            let message = check(url).expect_err(&format!("{url} must be rejected"));
            assert!(
                message.contains("拒否") || message.contains("解析"),
                "rejection must be explicit for {url}: {message}"
            );
        }
    }

    #[test]
    fn default_ports_resolve() {
        assert!(check("http://localhost/").is_ok());
        assert!(check("https://localhost/").is_ok());
    }
}
