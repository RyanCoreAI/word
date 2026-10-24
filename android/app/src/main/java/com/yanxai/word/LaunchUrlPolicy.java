package com.yanxai.word;

import java.net.URI;
import java.net.URISyntaxException;

final class LaunchUrlPolicy {
    private LaunchUrlPolicy() {}

    static boolean accepts(String value) {
        if (value == null) return false;
        try {
            URI uri = new URI(value);
            return "https".equalsIgnoreCase(uri.getScheme())
                    && "word.yanxai.com".equalsIgnoreCase(uri.getHost())
                    && uri.getRawUserInfo() == null
                    && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (URISyntaxException ignored) {
            return false;
        }
    }
}
