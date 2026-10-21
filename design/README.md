# 界面原型

| 图 | 内容 | 状态 |
|---|---|---|
| `mockups/1-看词记忆.png` | 看词记忆：出词、不认识后揭晓、复习词 | 已验收 |
| `mockups/2-听音辨词.png` | 听音辨词：只播放、不认识后揭晓、认识后切换 | 已验收 |
| `mockups/3-首页-小结-生词本-设置.png` | 首页、一组小结、生词本、设置 | 已验收（v1.1：数字改成真实统计值 11,481；「全部词条」改名「高频补充」；生词本加「刷这些词」按钮） |
| `mockups/4-首次打开-选词库-未学完.png` | 隐私同意、选词库、未学完的组 | 待验收 |
| `mockups/5-单词详情-账号-绑定邮箱.png` | 单词详情、账号与数据、绑定邮箱 | 待验收 |
| `mockups/6-官网-注销页-图标.png` | 官网首页、注销账号页、App 图标草案 | 待验收 |

图里的单词、数字都是示例；真实的数字规则见 `docs/`。

## 重新生成图片

```
cd design/mockups-src
npm install
node build.js        # 在 mockups-src/png/ 里生成 board1.png … board6.png
```

需要 Playwright 和 Chromium。颜色、字号等视觉数值以 `mockups-src/src/ui.css` 为准，App 实现时照此取值（`docs/07-mobile-app.md` 第 5 节已整理成 tokens）。
