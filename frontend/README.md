# XBOT Frontend

React + TypeScript + Vite 管理界面，统一展示固定 CA 策略、P20 动态喊单策略、信号、持仓、交易记录和运行设置。

## Runtime

- Node `24.11.x`
- npm `11.6.x`
- 开发端口默认 `5173`，可通过 Vite 参数覆盖
- `/api` 和 `/ws` 由 Vite/Nginx 代理到 XBOT 后端

## Commands

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd run lint
npm.cmd run build
```

生产发布必须使用与后端相同的 Git commit 构建。`dist`、日志、Token 和其他本地运行数据不得提交 Git。
