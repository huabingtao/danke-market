import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const CONFIG_FILE = path.resolve(__dirname, 'config.json');
const DATA_FILE = path.resolve(__dirname, 'board_data.json');
const RESET_STATUS_FILE = path.resolve(__dirname, '.last_reset_date');

// Load config
let config = {
  port: 8080,
  adminPassword: 'admin_change_me',
  timezone: 'Asia/Shanghai'
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch (e) {
    console.error('Failed to parse config.json, using default config:', e);
  }
}

// In-memory data cache
const emptyData = {
  egg: [],
  milk: [],
  goose: [],
  honey: [],
  wool: [],
  feather: []
};

let boardData = { ...emptyData };

if (fs.existsSync(DATA_FILE)) {
  try {
    boardData = { ...emptyData, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) };
    deduplicateDatabase();
  } catch (e) {
    console.error('Failed to parse board_data.json, initialized with empty data:', e);
  }
} else {
  saveDataToFile();
}

// Helper to deduplicate board database by ID
function deduplicateDatabase() {
  let changed = false;
  for (const key in boardData) {
    const seenIds = new Set();
    const uniqueList = [];
    for (const item of boardData[key]) {
      const cleanId = String(item.id || '').replace(/\D/g, '');
      if (!cleanId) {
        uniqueList.push(item);
        continue;
      }
      if (!seenIds.has(cleanId)) {
        seenIds.add(cleanId);
        uniqueList.push(item);
      } else {
        changed = true;
        console.log(`[Deduplicate] Removed duplicate ID row: crop=${key}, id=${cleanId}, price=${item.price}`);
      }
    }
    boardData[key] = uniqueList;
  }
  if (changed) {
    saveDataToFile();
  }
}

function saveDataToFile() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(boardData, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to write to board_data.json:', e);
  }
}

// Automatically clean up empty/invalid rows every 20 seconds (with 20s grace period)
setInterval(() => {
  const nowMs = Date.now();
  let dataChanged = false;
  
  for (const key in boardData) {
    const originalLength = boardData[key].length;
    boardData[key] = boardData[key].filter(item => {
      const creationTime = parseInt(item.itemId.split('_')[0], 10) || 0;
      const isTooOld = (nowMs - creationTime) > 20000;
      const isEmptyId = !item.id || item.id.trim() === '';
      const isEmptyPrice = !item.price || parseFloat(item.price) <= 0;
      
      if (isTooOld && (isEmptyId || isEmptyPrice)) {
        console.log(`[Auto-Cleanup] Removed empty/invalid row: crop=${key}, itemId=${item.itemId}, id=${item.id}, price=${item.price}`);
        return false;
      }
      return true;
    });
    if (boardData[key].length !== originalLength) {
      dataChanged = true;
    }
  }
  
  if (dataChanged) {
    saveDataToFile();
  }
}, 20000);

// Check and reset data according to schedule
function checkAndResetData() {
  const timezone = config.timezone || 'Asia/Shanghai';
  const now = new Date();
  
  try {
    // Format date in configured timezone
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(now);
    let year = '', month = '', day = '', hourStr = '';
    for (const part of parts) {
      if (part.type === 'year') year = part.value;
      if (part.type === 'month') month = part.value;
      if (part.type === 'day') day = part.value;
      if (part.type === 'hour') hourStr = part.value;
    }
    
    const dateStr = `${year}-${month}-${day}`;
    const currentHour = parseInt(hourStr, 10);

    // Event Active Period: Today (July 10) and Tomorrow (July 11)
    // 2-hour automatic reset on even hours
    const isEventActive = (dateStr <= '2026-07-11');

    if (isEventActive) {
      if (currentHour % 2 === 0) {
        const resetKey = `${dateStr}-${currentHour}`;
        let lastResetKey = '';
        if (fs.existsSync(RESET_STATUS_FILE)) {
          lastResetKey = fs.readFileSync(RESET_STATUS_FILE, 'utf-8').trim();
        }

        if (lastResetKey !== resetKey) {
          boardData = {
            egg: [],
            milk: [],
            goose: [],
            honey: [],
            wool: [],
            feather: []
          };
          saveDataToFile();
          fs.writeFileSync(RESET_STATUS_FILE, resetKey, 'utf-8');
          console.log(`[Auto-Reset] [Event Mode] Data auto-cleared at ${currentHour}:00 (${now.toLocaleString('zh-CN', { timeZone: timezone })} | ${timezone})`);
        }
      }
    } else {
      // Fallback: Standard daily 18:00 reset check
      if (currentHour >= 18) {
        let lastResetDate = '';
        if (fs.existsSync(RESET_STATUS_FILE)) {
          lastResetDate = fs.readFileSync(RESET_STATUS_FILE, 'utf-8').trim();
        }

        if (lastResetDate !== dateStr) {
          boardData = {
            egg: [],
            milk: [],
            goose: [],
            honey: [],
            wool: [],
            feather: []
          };
          saveDataToFile();
          fs.writeFileSync(RESET_STATUS_FILE, dateStr, 'utf-8');
          console.log(`[Auto-Reset] [Standard Mode] Data auto-cleared at 18:00 reset check (${now.toLocaleString('zh-CN', { timeZone: timezone })} | ${timezone})`);
        }
      }
    }
  } catch (e) {
    console.error('Failed to check or auto-reset data:', e);
  }
}

// Express App setup
const app = express();
app.use(cors());
app.use(express.json());

// Serves the compiled static frontend files
app.use(express.static(path.resolve(__dirname, 'dist')));

// Helper to check admin status
const isAdmin = (token) => {
  return token && token === config.adminPassword;
};

// Helper to get sorted board data (online first, then price descending)
const getSortedBoardData = () => {
  const sortedData = {};
  for (const key in boardData) {
    sortedData[key] = [...boardData[key]].sort((a, b) => {
      const aOnline = a.hasOwnProperty('online') ? a.online : true;
      const bOnline = b.hasOwnProperty('online') ? b.online : true;
      if (aOnline !== bOnline) {
        return aOnline ? -1 : 1;
      }
      return b.price - a.price;
    });
  }
  return sortedData;
};

// API: Get Board Data
app.get('/api/load', (req, res) => {
  checkAndResetData();
  res.json(getSortedBoardData());
});

// API: Add row
app.post('/api/add', (req, res) => {
  const { cropKey, id, price, ownerId, adminToken } = req.body;
  if (!boardData.hasOwnProperty(cropKey)) {
    return res.status(400).json({ error: 'Invalid crop key' });
  }

  const cleanId = String(id || '').replace(/\D/g, '');
  const cleanPrice = parseInt(String(price || '').replace(/\D/g, ''), 10) || 0;

  // Deduplicate check: if ID already exists in this category, merge/update instead of creating a new row
  if (cleanId) {
    const list = boardData[cropKey] || [];
    const existingItem = list.find(item => item.id === cleanId);
    if (existingItem) {
      existingItem.price = cleanPrice;
      existingItem.online = true;
      saveDataToFile();
      return res.json({ status: 'success', item: existingItem, merged: true });
    }
  }

  // Limit check: 1 entry per category for non-admins (only if not merged)
  const isUserAdmin = isAdmin(adminToken);
  if (!isUserAdmin && ownerId) {
    const list = boardData[cropKey] || [];
    const alreadyHas = list.some(item => item.ownerId === String(ownerId));
    if (alreadyHas) {
      return res.status(400).json({ error: 'Limit reached: regular users can only add one entry per category.' });
    }
  }

  const itemId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const newItem = {
    itemId,
    id: cleanId,
    price: cleanPrice,
    online: true,
    ownerId: String(ownerId || ''),
    likes: 0
  };

  boardData[cropKey].push(newItem);
  saveDataToFile();

  res.json({ status: 'success', item: newItem });
});

// API: Update row
app.post('/api/update', (req, res) => {
  const { cropKey, itemId, fields, ownerId, adminToken } = req.body;
  if (!boardData.hasOwnProperty(cropKey)) {
    return res.status(400).json({ error: 'Invalid crop key' });
  }

  const items = boardData[cropKey];
  const itemIndex = items.findIndex(i => i.itemId === itemId);

  if (itemIndex === -1) {
    return res.status(404).json({ error: 'Item not found' });
  }

  const item = items[itemIndex];

  // Auth: must be admin or the original owner
  if (!isAdmin(adminToken) && item.ownerId !== ownerId) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  // Perform updates
  if (fields.hasOwnProperty('id')) {
    item.id = String(fields.id).replace(/\D/g, '');
  }
  if (fields.hasOwnProperty('price')) {
    item.price = parseInt(String(fields.price).replace(/\D/g, ''), 10) || 0;
  }
  if (fields.hasOwnProperty('online')) {
    item.online = !!fields.online;
  }

  saveDataToFile();
  res.json({ status: 'success' });
});

// API: Delete row
app.post('/api/delete', (req, res) => {
  const { cropKey, itemId, ownerId, adminToken } = req.body;
  if (!boardData.hasOwnProperty(cropKey)) {
    return res.status(400).json({ error: 'Invalid crop key' });
  }

  const items = boardData[cropKey];
  const itemIndex = items.findIndex(i => i.itemId === itemId);

  if (itemIndex === -1) {
    return res.status(404).json({ error: 'Item not found' });
  }

  const item = items[itemIndex];

  // Auth: must be admin or the original owner
  if (!isAdmin(adminToken) && item.ownerId !== ownerId) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  items.splice(itemIndex, 1);
  saveDataToFile();

  res.json({ status: 'success' });
});

// API: Like an item (Click to increase like count by 1)
app.post('/api/like', (req, res) => {
  const { cropKey, itemId } = req.body;
  if (!boardData.hasOwnProperty(cropKey)) {
    return res.status(400).json({ error: 'Invalid crop key' });
  }

  const items = boardData[cropKey];
  const item = items.find(i => i.itemId === itemId);
  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }

  item.likes = (item.likes || 0) + 1;
  saveDataToFile();
  res.json({ status: 'success', likes: item.likes });
});

// API: Clear all data (Admin only)
app.post('/api/clear', (req, res) => {
  const { adminToken } = req.body;
  if (!isAdmin(adminToken)) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  for (const key in boardData) {
    boardData[key] = [];
  }

  saveDataToFile();
  res.json({ status: 'success' });
});

// API: Sort all data (Admin only)
app.post('/api/sort', (req, res) => {
  const { adminToken } = req.body;
  if (!isAdmin(adminToken)) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  for (const key in boardData) {
    boardData[key].sort((a, b) => {
      // Online status takes priority
      const aOnline = a.hasOwnProperty('online') ? a.online : true;
      const bOnline = b.hasOwnProperty('online') ? b.online : true;
      if (aOnline !== bOnline) {
        return aOnline ? -1 : 1;
      }
      // Price descending next
      return b.price - a.price;
    });
  }

  saveDataToFile();
  res.json({ status: 'success', boardData });
});

// Serve frontend routing for SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
});

// Start listening
const PORT = Number(process.env.PORT || (process.env.NODE_ENV === "production" ? (config.port || 8080) : 6106));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`  欢乐牧场看板已启动：http://localhost:${PORT}`);
  console.log(`  管理密码：${config.adminPassword}`);
  console.log(`  时区设置：${config.timezone}`);
  console.log(`===============================================`);
});
