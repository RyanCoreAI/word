package com.yanxai.word;

import org.junit.Test;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class LaunchUrlPolicyTest {
    @Test public void allowsOnlyTheHttpsWordOrigin() {
        assertTrue(LaunchUrlPolicy.accepts("https://word.yanxai.com/"));
        assertTrue(LaunchUrlPolicy.accepts("HTTPS://WORD.YANXAI.COM:443/?from=card#study"));
        assertTrue(LaunchUrlPolicy.accepts("https://word.yanxai.com/path?redirect=https://example.com"));
    }
    @Test public void rejectsForeignOriginsAndPorts() {
        for (String value : new String[] {"http://word.yanxai.com/", "https://yanxai.com/", "https://word.yanxai.com.evil.example/", "https://evil.example/word.yanxai.com", "https://word.yanxai.com:8443/", "https://word.yanxai.com./"}) assertFalse(value, LaunchUrlPolicy.accepts(value));
    }
    @Test public void rejectsUserInfoAndAmbiguousParsing() {
        for (String value : new String[] {"https://word.yanxai.com@evil.example/", "https://user@word.yanxai.com/", "https://word.yanxai.com\\@evil.example/", "https://word.yanxai.com/%", "https://word.yanxai.com:invalid/", "//word.yanxai.com/"}) assertFalse(value, LaunchUrlPolicy.accepts(value));
    }
    @Test public void rejectsNonWebIntentsAndEmptyValues() {
        for (String value : new String[] {null, "", " ", "javascript:alert(1)", "content://word.yanxai.com/", "file:///etc/passwd", "intent://word.yanxai.com/"}) assertFalse(LaunchUrlPolicy.accepts(value));
    }
}
