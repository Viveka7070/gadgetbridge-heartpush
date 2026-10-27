# 版权与来源

- 改版 App 基于 **Gadgetbridge**（https://codeberg.org/Freeyourgadget/Gadgetbridge），
  上游提交 `eb4b8fc9b97c355774171843f5adda7c1f8cd4e7`，许可 AGPL-3.0。原版权归 Gadgetbridge 各位贡献者。
- 本仓库的全部改动（`heart-push.patch`）以及配套的后端示例（`heart.js`、`daily.js`、`server-example.js`）同样以 AGPL-3.0 发布，见 `LICENSE`。
- 仓库里的 `gadgetbridge-heartpush.apk` 就是用上面那个上游提交 + `heart-push.patch` 编出来的，对应源码 = 上游该提交 + 本补丁。

自己编译：
```
git clone https://codeberg.org/Freeyourgadget/Gadgetbridge.git && cd Gadgetbridge
git checkout eb4b8fc9b97c355774171843f5adda7c1f8cd4e7
git apply ../heart-push.patch
./gradlew assembleMainlineNightly
```
