package com.yanxai.word;

import android.content.Intent;
import android.net.Uri;
import com.google.androidbrowserhelper.trusted.LauncherActivity;

public final class WordLauncherActivity extends LauncherActivity {
    @Override
    protected Uri getUrlForIntent(Intent intent) {
        Uri candidate = intent.getData();
        return candidate != null && LaunchUrlPolicy.accepts(candidate.toString()) ? candidate : null;
    }
}
