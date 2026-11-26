# 弈 · 在线棋室

一个零第三方依赖的 Node.js 多人棋类对战站点：首页选择游戏，支持**中国象棋**与**五子棋**，双人实时对弈、自由旁观与弹幕聊天。

## 游戏

### 中国象棋（/xiangqi.html）

- **完整棋规**：车马炮相仕帅兵卒走法、蹩马腿、塞象眼、白脸将、将军 / 将死 / 困毙判定，全部在服务端校验
- **专业棋谱**：每一手自动生成中式记谱（如「炮二平五」「马8进7」），含前/后同列棋子消歧
- **三款皮肤**：古木、墨玉、青瓷，选择保存在本地
- 每步 90 秒限时，超时判负；支持认输与双方确认重开

### 五子棋（/gomoku.html）

- **十五路棋盘**：黑先白后，服务端校验轮次与占位，率先连成五子者胜
- **坐标棋谱**：每一手记录为标准坐标（如 `H8`），左右双列展示
- **胜负高亮**：五子连线在棋盘上高亮标出；棋盘下满判和
- 每步 60 秒限时，超时判负；支持认输与双方确认重开

### 公共能力

- **棋室大厅**：创建棋室、席位与在线状态、观战人数、手数一览，自动刷新
- **观战模式**：座位坐满后仍可进入观战，观战名单实时展示
- **弹幕聊天**：棋手与观众的消息以弹幕形式飘过棋盘，右侧保留聊天记录，可一键关闭弹幕
- **实时同步**：基于 HTTP 长轮询，天然穿透各类代理，无需 WebSocket

## 本地运行

```bash
node server.js          # 默认 http://localhost:8000
PORT=3000 node server.js
```

## 目录结构

```
server.js           # HTTP 服务 + 象棋棋规引擎 + 房间状态 + 长轮询
gomoku.js           # 五子棋房间、棋规与 API（与象棋状态隔离）
public/index.html   # 首页：选择中国象棋 / 五子棋
public/home.css     # 首页样式
public/xiangqi.html # 象棋大厅与棋室
public/app.js       # 象棋棋盘绘制、交互、同步轮询、弹幕
public/gomoku.html  # 五子棋大厅与棋室
public/gomoku.js    # 五子棋棋盘绘制、交互、同步轮询、弹幕
public/gomoku.css   # 五子棋补充样式
public/styles.css   # 共用视觉样式
build.sh / run.sh   # 部署适配脚本
```

## API

- 象棋：`/api/rooms`、`/api/rooms/:id/{sync,join,move,chat,resign,rematch}`
- 五子棋：`/api/gomoku/rooms`、`/api/gomoku/rooms/:id/{sync,join,move,chat,resign,rematch}`

## 说明

棋室与对局状态保存在服务进程内存中，进程重启后清空；适合轻量娱乐对局。
