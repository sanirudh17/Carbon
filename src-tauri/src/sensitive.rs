use base64::Engine;

pub fn is_sensitive_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    is_private_key(trimmed) || is_api_key(trimmed) || is_jwt(trimmed) || is_credit_card(trimmed)
}

fn is_private_key(text: &str) -> bool {
    text.contains("-----BEGIN") && text.contains("PRIVATE KEY-----")
}

fn is_api_key(text: &str) -> bool {
    if text.len() < 16 || text.len() > 300 || text.contains('\n') || text.contains(' ') {
        return false;
    }

    let prefixes = [
        "sk-",
        "sk_live_",
        "rk_live_",
        "pk_live_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "glpat-",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxr-",
        "AKIA",
        "ABIA",
        "ACCA",
        "ASIA",
        "AIzaSy",
    ];

    prefixes.iter().any(|&prefix| text.starts_with(prefix))
}

fn is_jwt(text: &str) -> bool {
    if text.len() < 24 || text.contains('\n') || text.contains(' ') {
        return false;
    }

    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 3 {
        return false;
    }

    let is_b64url = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '=');
    if !parts.iter().all(|p| is_b64url(p)) {
        return false;
    }

    // Try decoding the JWT header to check for standard fields
    let decode_header = |raw: &str| -> Option<String> {
        if let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw) {
            if let Ok(s) = String::from_utf8(bytes) {
                return Some(s);
            }
        }
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(raw) {
            if let Ok(s) = String::from_utf8(bytes) {
                return Some(s);
            }
        }
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) {
            if let Ok(s) = String::from_utf8(bytes) {
                return Some(s);
            }
        }
        None
    };

    if let Some(header_json) = decode_header(parts[0]) {
        let lower = header_json.to_lowercase();
        if lower.contains("\"alg\"") || lower.contains("\"typ\"") {
            return true;
        }
    }

    // Even if header JSON wasn't strict UTF-8, if each part is long enough and formatted as JWT
    parts[0].len() >= 10 && parts[1].len() >= 10 && parts[2].len() >= 10
}

fn is_luhn_valid(digits: &str) -> bool {
    let digits: Vec<u32> = digits.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }

    let mut sum = 0;
    let mut double = false;
    for &d in digits.iter().rev() {
        if double {
            let mut val = d * 2;
            if val > 9 {
                val -= 9;
            }
            sum += val;
        } else {
            sum += d;
        }
        double = !double;
    }
    sum % 10 == 0
}

fn is_credit_card(text: &str) -> bool {
    if text.len() < 13 || text.len() > 30 {
        return false;
    }

    // Must consist only of digits, spaces, or dashes
    if !text.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-') {
        return false;
    }

    let clean: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() < 13 || clean.len() > 19 {
        return false;
    }

    let first2: u32 = clean[..2.min(clean.len())].parse().unwrap_or(0);
    let first = clean.chars().next().unwrap_or('0');

    // Common card IIN ranges: Visa (4), Mastercard (51-55, 22-27), Amex (34, 37), Discover (6011, 65, 644-645), JCB (35)
    let is_known_iin = first == '4'
        || (first2 >= 51 && first2 <= 55)
        || (first2 >= 22 && first2 <= 27)
        || first2 == 34
        || first2 == 37
        || first2 == 65
        || clean.starts_with("6011")
        || first2 == 35
        || clean.starts_with("644")
        || clean.starts_with("645");

    if is_known_iin {
        is_luhn_valid(&clean)
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_api_keys() {
        assert!(is_sensitive_text("sk-proj-1234567890abcdefghijklmn"));
        assert!(is_sensitive_text("ghp_1234567890abcdefghijklmn1234567890"));
        assert!(is_sensitive_text("AKIAIOSFODNN7EXAMPLE"));
        assert!(!is_sensitive_text("hello world"));
    }

    #[test]
    fn test_private_key() {
        assert!(is_sensitive_text("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"));
        assert!(is_sensitive_text("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza...\n-----END OPENSSH PRIVATE KEY-----"));
    }

    #[test]
    fn test_jwt() {
        assert!(is_sensitive_text("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"));
    }
}
