import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const cropConfigs = {
  egg: { name: '🍳 鸡蛋', range: '225 - 250', color: 'var(--egg-color)' },
  milk: { name: '🥛 牛奶', range: '225 - 250', color: 'var(--milk-color)' },
  goose: { name: '🪶 鹅绒', range: '675 - 750', color: 'var(--goose-color)' },
  honey: { name: '🍯 蜂蜜', range: '675 - 750', color: 'var(--honey-color)' },
  wool: { name: '🐑 羊毛', range: '2250 - 2500', color: 'var(--wool-color)' },
  feather: { name: '🦚 翎羽', range: '6750 - 7500', color: 'var(--feather-color)' }
};

export default function App() {
  const [boardData, setBoardData] = useState({
    egg: [],
    milk: [],
    goose: [],
    honey: [],
    wool: [],
    feather: []
  });

  const [adminToken, setAdminToken] = useState(localStorage.getItem('danke_ranch_admin_token') || '');
  const [ownerId] = useState(() => {
    let id = localStorage.getItem('danke_ranch_owner_id');
    if (!id) {
      id = 'client_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem('danke_ranch_owner_id', id);
    }
    return id;
  });

  const [toastMsg, setToastMsg] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const lastEditTime = useRef(0);
  const toastTimer = useRef(null);

  // Helper for dynamic API base path
  const getApiUrl = (endpoint) => {
    return endpoint;
  };

  // Toast helper
  const triggerToast = (msg) => {
    setToastMsg(msg);
    setShowToast(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      setShowToast(false);
    }, 2500);
  };

  // Check URL parameters for admin token on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const adminParam = params.get('admin');
    
    if (adminParam !== null) {
      localStorage.setItem('danke_ranch_admin_token', adminParam);
      setAdminToken(adminParam);
      
      // Clean URL parameters without reloading page
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
      triggerToast('管理员密钥已载入！');
    }

    // Load initial data from server
    fetch(getApiUrl('/api/load'))
      .then(res => res.json())
      .then(serverData => {
        if (serverData && typeof serverData === 'object') {
          setBoardData(serverData);
        }
      })
      .catch(err => console.warn('Failed to load initial server data:', err));
  }, [adminToken]);

  // Poll server every 20 seconds for updates
  useEffect(() => {
    const interval = setInterval(() => {
      // If we made an edit recently, suspend polling for 22s to avoid breaking user focus
      if (Date.now() - lastEditTime.current < 22000) {
        return;
      }
      fetch(getApiUrl('/api/load'))
        .then(res => res.json())
        .then(serverData => {
          if (serverData && typeof serverData === 'object') {
            setBoardData(serverData);
          }
        })
        .catch(err => console.warn('Failed to poll server data:', err));
    }, 20000);

    return () => clearInterval(interval);
  }, []);

  // Clean up isNew animation tags after render
  useEffect(() => {
    let hasNew = false;
    const nextData = {};
    for (const key in boardData) {
      nextData[key] = boardData[key].map(item => {
        if (item.isNew) {
          hasNew = true;
          const copy = { ...item };
          delete copy.isNew;
          return copy;
        }
        return item;
      });
    }

    if (hasNew) {
      const timer = setTimeout(() => {
        setBoardData(nextData);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [boardData]);

  // Admin Logout
  const handleLogout = () => {
    localStorage.removeItem('danke_ranch_admin_token');
    setAdminToken('');
    triggerToast('已退出管理员模式');
  };

  // Add new data row (API call with local optimistic insert)
  const handleAddRow = (cropKey) => {
    lastEditTime.current = Date.now();

    // Check limit: 1 entry per category for non-admins
    const list = boardData[cropKey] || [];
    const alreadyHas = list.some(item => item.ownerId === ownerId);
    if (!adminToken && alreadyHas) {
      triggerToast('防刷限制：每人每个分类限加一条报价数据！');
      return;
    }

    const config = cropConfigs[cropKey];
    const defaultPrice = parseInt(config.range.split(' - ')[0]) || 0;

    // Use a temporary local item ID
    const tempItemId = `temp_${Date.now()}`;
    const tempItem = { itemId: tempItemId, id: '', price: defaultPrice, online: true, ownerId, isNew: true };
    
    // Insert locally first for fast response
    setBoardData(prev => ({
      ...prev,
      [cropKey]: [...(prev[cropKey] || []), tempItem]
    }));

    // Send API request
    fetch(getApiUrl('/api/add'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cropKey,
        id: '',
        price: defaultPrice,
        ownerId,
        adminToken
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === 'success' && data.item) {
        // Swap temp item with actual item containing database fields
        setBoardData(prev => ({
          ...prev,
          [cropKey]: prev[cropKey].map(item => item.itemId === tempItemId ? data.item : item)
        }));
      }
    })
    .catch(err => {
      console.error('Failed to add item to server:', err);
      triggerToast('添加行失败，请重试');
    });

    // Auto focus the input after render
    setTimeout(() => {
      const card = document.getElementById(`card-${cropKey}`);
      if (card) {
        const inputs = card.querySelectorAll('.input-id');
        if (inputs.length > 0) {
          inputs[inputs.length - 1].focus();
        }
      }
    }, 100);
  };

  // Modify item fields
  const handleUpdateItem = (cropKey, itemId, key, value) => {
    lastEditTime.current = Date.now();
    let parsedValue = value;
    if (key === 'price') {
      parsedValue = parseFloat(value) || 0;
    }

    // Update locally first
    setBoardData(prev => {
      const list = prev[cropKey] || [];
      const updatedList = list.map(item => {
        if (item.itemId === itemId) {
          return { ...item, [key]: parsedValue };
        }
        return item;
      });
      return { ...prev, [cropKey]: updatedList };
    });

    // Send API request
    fetch(getApiUrl('/api/update'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cropKey,
        itemId,
        fields: { [key]: parsedValue },
        ownerId,
        adminToken
      })
    }).catch(err => console.error('Failed to update item on server:', err));
  };

  // Toggle online status
  const handleToggleOnline = (cropKey, itemId) => {
    lastEditTime.current = Date.now();
    
    // Find the item in boardData synchronously
    const list = boardData[cropKey] || [];
    const item = list.find(i => i.itemId === itemId);
    if (!item) return;
    
    const currentOnline = item.hasOwnProperty('online') ? item.online : true;
    const nextOnline = !currentOnline;

    // Update locally first
    setBoardData(prev => {
      const list = prev[cropKey] || [];
      const updatedList = list.map(i => {
        if (i.itemId === itemId) {
          return { ...i, online: nextOnline };
        }
        return i;
      });
      return { ...prev, [cropKey]: updatedList };
    });

    // Send API request
    fetch(getApiUrl('/api/update'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cropKey,
        itemId,
        fields: { online: nextOnline },
        ownerId,
        adminToken
      })
    }).catch(err => console.error('Failed to toggle status on server:', err));
  };

  // Delete data row
  const handleDeleteRow = (cropKey, itemId) => {
    lastEditTime.current = Date.now();

    // Delete locally first
    setBoardData(prev => ({
      ...prev,
      [cropKey]: (prev[cropKey] || []).filter(item => item.itemId !== itemId)
    }));

    // Send API request
    fetch(getApiUrl('/api/delete'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cropKey,
        itemId,
        ownerId,
        adminToken
      })
    }).catch(err => {
      console.error('Failed to delete row on server:', err);
      triggerToast('删除行失败');
    });
  };

  // Like data row
  const handleLikeItem = (cropKey, itemId) => {
    lastEditTime.current = Date.now();

    // Optimistic local update
    setBoardData(prev => {
      const list = prev[cropKey] || [];
      const updatedList = list.map(item => {
        if (item.itemId === itemId) {
          return { ...item, likes: (item.likes || 0) + 1 };
        }
        return item;
      });
      return { ...prev, [cropKey]: updatedList };
    });

    // Send API request
    fetch(getApiUrl('/api/like'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cropKey,
        itemId
      })
    }).catch(err => console.error('Failed to register like on server:', err));
  };

  // Sort all crops descending (Admin only)
  const handleSortAll = () => {
    if (!adminToken) return;
    lastEditTime.current = Date.now();

    fetch(getApiUrl('/api/sort'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ adminToken })
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === 'success' && data.boardData) {
        setBoardData(data.boardData);
        triggerToast('已按“在线优先、价格从高到低”完成全服排序！');
      } else {
        triggerToast('排序未成功，请检查密码权限！');
      }
    })
    .catch(err => {
      console.error('Failed to sort:', err);
      triggerToast('排序错误');
    });
  };

  // Trigger modal open
  const handleOpenClearModal = () => {
    setShowConfirmModal(true);
  };

  // Confirm clear all (Admin only)
  const handleConfirmClearAll = () => {
    if (!adminToken) return;

    fetch(getApiUrl('/api/clear'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ adminToken })
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === 'success') {
        const cleared = {};
        for (const key in boardData) {
          cleared[key] = [];
        }
        setBoardData(cleared);
        setShowConfirmModal(false);
        triggerToast('已清空所有服务器价格数据！');
      } else {
        triggerToast('清空失败，密码错误或权限不足！');
      }
    })
    .catch(err => {
      console.error('Failed to clear data:', err);
      triggerToast('清空失败');
    });
  };

  // Copy board data to clipboard (including website URL at the top)
  const handleCopyBoard = () => {
    let text = '价格看板：http://happyranch.guaguahub.cn/\n📋 欢乐牧场挂菜价格看板\n';
    let hasContent = false;

    for (const key in cropConfigs) {
      const config = cropConfigs[key];
      const list = boardData[key] || [];
      const validList = list.filter(item => (item.id || '').trim() !== '' && item.price > 0);

      if (validList.length > 0) {
        hasContent = true;
        const sortedList = [...validList].sort((a, b) => {
          const aOnline = a.hasOwnProperty('online') ? a.online : true;
          const bOnline = b.hasOwnProperty('online') ? b.online : true;
          if (aOnline !== bOnline) {
            return aOnline ? -1 : 1;
          }
          return b.price - a.price;
        });
        text += `${config.name} (上限 ${config.range.split(' - ')[1]}):\n`;
        sortedList.forEach((item, idx) => {
          const isOnline = item.hasOwnProperty('online') ? item.online : true;
          const statusText = isOnline ? ' (在线)' : ' (下线)';
          text += `  🥇 ${idx + 1}. [${item.id}] 价格: ${item.price}${statusText}\n`;
        });
      }
    }

    if (!hasContent) {
      triggerToast('看板中没有任何有效数据可供复制哦~');
      return;
    }

    copyTextToClipboard(text)
      .then(() => triggerToast('复制成功！快发去群里或评论区吧'))
      .catch(err => {
        console.error('Failed to copy text: ', err);
        prompt('复制失败，请手动全选复制以下文本：', text);
      });
  };

  // Copy ID helper
  const handleCopyId = (idText) => {
    if (!idText || idText.trim() === '') {
      triggerToast('ID为空，无法复制！');
      return;
    }
    copyTextToClipboard(idText.trim())
      .then(() => triggerToast(`已复制 ID: ${idText.trim()}`))
      .catch(err => {
        console.error('Failed to copy ID: ', err);
        triggerToast('复制失败');
      });
  };

  // Copy WeChat ID helper
  const handleCopyWeChat = (wechatId) => {
    copyTextToClipboard(wechatId)
      .then(() => triggerToast(`已复制微信号: ${wechatId}，快去微信添加好友吧！`))
      .catch(err => {
        console.error('Failed to copy WeChat ID: ', err);
        triggerToast(`复制失败，请手动记录微信号：${wechatId}`);
      });
  };

  // Clipboard polyfill
  const copyTextToClipboard = (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    } else {
      return new Promise((resolve, reject) => {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
          const successful = document.execCommand('copy');
          document.body.removeChild(textArea);
          if (successful) resolve();
          else reject(new Error('textarea copy command failed'));
        } catch (err) {
          document.body.removeChild(textArea);
          reject(err);
        }
      });
    }
  };

  return (
    <>
      <header>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: '10px' }}>
            <img className="market-brand-logo" src={`${import.meta.env.BASE_URL}brand/cai-mark.svg`} alt="" width="44" height="44" />
            欢乐牧场价格看板
          </h1>
          <span style={{ fontSize: '0.68rem', color: '#f1f5f9', opacity: 0.85, fontWeight: 400, letterSpacing: '0.5px' }}>
            http://happyranch.guaguahub.cn
          </span>
        </div>
        {adminToken && (
          <div className="admin-badge">
            👑 管理员模式 
            <button className="btn-logout" onClick={handleLogout} style={{ marginLeft: '8px', fontSize: '0.6rem', padding: '2px 6px', background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '4px', cursor: 'pointer' }}>
              退出
            </button>
          </div>
        )}
      </header>

      <main>
        {/* 温馨提示 banner */}
        <div className="tips-banner" style={{ display: 'flex', alignItems: 'center', textAlign: 'left', padding: '6px 12px', gap: '12px' }}>
          <div style={{ fontWeight: '800', fontSize: '0.72rem', borderRight: '1px solid rgba(245, 158, 11, 0.25)', paddingRight: '10px', lineHeight: '1.2', flexShrink: 0, color: '#fbbf24' }}>
            流程
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '4px 16px', fontSize: '0.68rem', color: '#fbbf24', opacity: 0.95 }}>
            <div><b>菜王</b>：1.填写id 和 价格 2.保持在线通过好友</div>
            <div><b>卖菜</b>：1.搜索id加好友 2.卖对应菜 3.删除好友</div>
          </div>
        </div>

        {/* 动物卡片网格容器 */}
        <div className="cards-grid" id="cards-grid" style={{ marginTop: '4px' }}>
          {Object.entries(cropConfigs).map(([key, config]) => {
            const rawItems = boardData[key] || [];
            const items = [...rawItems].sort((a, b) => {
              const aOnline = a.hasOwnProperty('online') ? a.online : true;
              const bOnline = b.hasOwnProperty('online') ? b.online : true;
              if (aOnline !== bOnline) {
                return aOnline ? -1 : 1;
              }
              return b.price - a.price;
            });
            return (
              <div className="crop-card" key={key} id={`card-${key}`} style={{ '--crop-theme-color': config.color }}>
                <div className="crop-card-inner">
                  <div className="card-header">
                    <div className="crop-title-wrapper">
                      <span
                        className="crop-badge"
                        style={{ color: config.color, backgroundColor: config.color }}
                      ></span>
                      <span className="crop-name">{config.name}</span>
                    </div>
                    <div className="price-range">
                      最高价: {config.range.split(' - ')[1]}
                    </div>
                  </div>

                  <div className="id-list" id={`list-${key}`}>
                    {items.length === 0 ? (
                      <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '8px 0', fontSize: '0.62rem' }}>
                        恭迎菜皇
                      </div>
                    ) : (
                      items.map((item, index) => {
                        const isOnline = item.hasOwnProperty('online') ? item.online : true;
                        const statusClass = isOnline ? 'status-online' : 'status-offline';
                        const offlineClass = isOnline ? '' : 'is-offline';
                        const statusText = isOnline ? '在线' : '下线';
                        const newClass = item.isNew ? 'row-new' : '';
                        
                        // Auth check: can this client edit this row?
                        const isOwner = item.ownerId === ownerId;
                        const canEdit = isOwner || !!adminToken;
                        const rowOwnerClass = isOwner ? 'is-owner' : 'is-not-owner';

                        return (
                          <div className={`id-row rank-${index + 1} ${offlineClass} ${newClass} ${rowOwnerClass}`} key={item.itemId || index}>
                            <div className="rank-badge">{index + 1}</div>
                            <button
                              className={`btn-status ${statusClass}`}
                              onClick={() => handleToggleOnline(key, item.itemId)}
                              disabled={!canEdit}
                              title={canEdit ? "切换在线状态" : "无权修改此数据"}
                            >
                              <span className="status-text">{statusText}</span>
                            </button>
                            <input
                              type="text"
                              className="input-id"
                              placeholder="游戏ID"
                              value={item.id || ''}
                              disabled={!canEdit}
                              onInput={(e) => {
                                const cleanedVal = e.target.value.replace(/\D/g, '');
                                e.target.value = cleanedVal;
                                handleUpdateItem(key, item.itemId, 'id', cleanedVal);
                              }}
                              style={{ flex: 1, minWidth: 0 }}
                            />
                            <div className="right-controls" style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                              {(item.id || '').trim() !== '' && (
                                <button
                                  className="btn-copy-id"
                                  onClick={() => handleCopyId(item.id)}
                                  title="复制 ID"
                                  style={{
                                    fontSize: '0.54rem',
                                    color: 'var(--accent-gold)',
                                    background: 'rgba(251, 191, 36, 0.1)',
                                    border: '1px solid rgba(251, 191, 36, 0.2)',
                                    borderRadius: '3px',
                                    padding: '1px 3px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    height: '16px',
                                    flexShrink: 0
                                  }}
                                >
                                  复制
                                </button>
                              )}
                              <input
                                type="text"
                                inputMode="numeric"
                                className="input-price"
                                placeholder="价格"
                                value={item.price || ''}
                                disabled={!canEdit}
                                onInput={(e) => {
                                  const cleanedVal = e.target.value.replace(/\D/g, '');
                                  e.target.value = cleanedVal;
                                  handleUpdateItem(key, item.itemId, 'price', cleanedVal);
                                }}
                                style={{ width: '58px', flexShrink: 0 }}
                              />
                              <button
                                className="btn-like"
                                onClick={() => handleLikeItem(key, item.itemId)}
                                title="点赞"
                              >
                                👍 <span className="like-count">{item.likes || 0}</span>
                              </button>
                              {canEdit ? (
                                <button
                                  className="btn-delete"
                                  onClick={() => handleDeleteRow(key, item.itemId)}
                                  title="删除"
                                  style={{ flexShrink: 0 }}
                                >
                                  <svg width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                </button>
                              ) : (
                                <div style={{ width: '12px', flexShrink: 0 }} /> /* Spacing equal to delete button */
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <button className="btn-add" onClick={() => handleAddRow(key)}>
                    <svg width="8" height="8" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                    </svg>
                    添加
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* 弹壳伤害计算器 */}
        <div className="calculator-section">
          <div className="calc-inline-row">
            <span className="calc-label">🧮 弹壳伤害计算器：</span>
            <a href="https://survivor-fh.top/" target="_blank" rel="noopener noreferrer" className="calc-link-text">
              国内代理 (survivor-fh.top)
            </a>
            <span className="calc-divider">|</span>
            <a href="https://sio-tools.exp0.dev/?migrate=1" target="_blank" rel="noopener noreferrer" className="calc-link-text">
              国外版 (sio-tools.exp0.dev)
            </a>
            <span className="calc-chrome-tip">（推荐用 Chrome 访问）</span>
          </div>
        </div>

        {/* 二维码与联系方式模块 */}
        <div className="qr-section">
          <div className="qr-item">
            <img src="/弹壳呱呱公众号二维码.jpg" alt="公众号" />
            <span>关注弹壳攻略<br />公众号</span>
          </div>
          <div
            className="wechat-id-box"
            onClick={() => handleCopyWeChat('alcl8586')}
            title="点击复制微信号"
          >
            <span className="wechat-label">💬 进卖菜群加绿泡泡</span>
            <span className="wechat-val">alcl8586</span>
          </div>
        </div>
      </main>

      {/* 底部控制栏 */}
      <div className="control-bar">
        {adminToken && (
          <button className="control-btn btn-sort" onClick={handleSortAll}>
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z" />
            </svg>
            一键排序
          </button>
        )}
        <button className="control-btn btn-copy" onClick={handleCopyBoard}>
          <svg width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
          </svg>
          复制文案
        </button>
        {adminToken && (
          <button className="control-btn btn-clear" onClick={handleOpenClearModal}>
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
            </svg>
            一键清空
          </button>
        )}
      </div>

      {/* 复制成功的通知浮点 */}
      <div className={`toast ${showToast ? 'show' : ''}`} id="toast">
        {toastMsg}
      </div>

      {/* 自定义确认弹窗 Modal */}
      {showConfirmModal && (
        <div className="confirm-modal show" id="confirm-modal" style={{ display: 'flex' }}>
          <div className="confirm-content">
            <div className="confirm-title">⚠️ 确认清空</div>
            <div className="confirm-body">确认要重置清空所有数据吗？此操作无法恢复。</div>
            <div className="confirm-actions">
              <button className="confirm-action-btn btn-modal-cancel" onClick={() => setShowConfirmModal(false)}>
                取消
              </button>
              <button className="confirm-action-btn btn-modal-confirm" onClick={handleConfirmClearAll}>
                确认清空
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
