# tiny-kit

零依赖的小工具集，用于评估 agent 在真实仓库里的开发闭环。

每个工具都有一组 `node:test` 用例；其中一部分用例当前是失败的，属于待修复缺陷。
测试命令：`node --test --test-reporter=tap test/<name>.test.mjs`
