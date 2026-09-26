'use strict';
const express = require('express');
const path = require('path');
const tasksRouter = require('./src/routes/tasks');
const sampleRouter = require('./src/routes/sample');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/tasks', tasksRouter);
app.use('/api', sampleRouter);

// 统一错误处理（multer 等）
app.use((err, req, res, next) => {
  if (err) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message || '请求处理失败' });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`药品目录大批量导入系统已启动：http://localhost:${PORT}`);
});
