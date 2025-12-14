// 引入工具方法：高分 canvas、图片加载、朝向绘制、导出、转码兜底、离屏画布创建
const { createHighResCanvas, loadImageFrom, calcPreviewHeight, drawWithOrientation, safeCanvasToTempFilePath, tryTranscodeIfNeeded, safeCreateOffscreenCanvas } = require('../../utils/canvas.js');

const SUPPORTED_IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
const SAVED_PATH_REG = /^wxfile:\/\/(usr|store)/i;
const IOS_BITMAP_BUDGET = 64 * 1000 * 1000; // 约 64MP
const ANDROID_BITMAP_BUDGET = 42 * 1000 * 1000; // 约 42MP
const DEFAULT_BITMAP_CACHE_LIMIT = 6;
const ANDROID_BITMAP_CACHE_LIMIT = 4;

Page({
	data: {
		images: [],
		direction: 'vertical',
		gap: 0,
		stitchedTempPath: '',
		canvasPreviewHeight: 240,
		selectedIndex: -1,
		// 拼图进度
		isStitching: false,
		stitchProgress: 0,
		// 缩略图拖拽网格参数
		thumbWpx: 0,
		thumbGapPx: 0,
		columns: 1,
		thumbsHeight: 0,
		addX: 0,
		addY: 0,
		canAdd: true,
		lastLayoutRows: 0,
		dragging: false,
		dragIndex: -1,
		dragShadowIndex: -1,
		// 删除对话框
		showDeleteModal: false,
		modalImage: '',
		modalIndex: -1,
		// 拼接设置
		showGapModal: false,
		gapModalTitle: '',
		gapTemp: 0,
		showGapInput: false,
		gapInputFocus: false,
		// 温馨提示
		showTips: true, // 保留但不再用于隐藏，仅占位
		tipsTransparent: false,
		_lastTipsTap: 0,
		// 多选删除
		multiSelectMode: false,
		selectedCount: 0,
		_lastBlankTap: 0,

		// 大图加载进度（总大小较大时展示）
		isPreparing: false,
		prepareProgress: 0,
		prepareNote: '',
		prepareTotalMB: 0,
	},

	// 空操作：用于遮罩拦截点击 
	noop() {},

	// 拖拽开始
	onDragStart(e) {
		const idx = e.currentTarget.dataset.index;
		const imgs = this.data.images.slice();
		// 开始拖拽：仅记录索引，保持高度与上传卡片位置不变
		this.setData({ dragging: true, dragIndex: idx, dragShadowIndex: idx });
	},

	// 拖拽过程中：根据当前位置计算目标索引并重排
	onDragMoving(e) {
		if (!this.data.dragging) return;
		const { x, y, source } = e.detail || {};
		if (source !== 'touch') return;
		const to = this._computeCellIndex(x, y);
		let imgs = this._withShadowPositions(this.data.images, this.data.dragIndex, to);
		// 被拖拽项直接跟随手指
		imgs[this.data.dragIndex] = { ...imgs[this.data.dragIndex], x, y };
		// 在拖动过程中，不改变容器高度与上传卡片位置，避免文案抖动与卡片遮挡
		this.setData({ images: imgs, dragShadowIndex: to, stitchedTempPath: '', stitchProgress: 0 });
	},

	// 拖拽结束：收尾
	onDragEnd() {
		const { dragIndex, dragShadowIndex } = this.data;
		if (dragIndex < 0) { this.setData({ dragging: false, dragShadowIndex: -1 }); return; }
		const arr = this.data.images.slice();
		// 将被拖拽项吸附到网格目标位
		const snap = this._getXYByIndex(dragShadowIndex);
		arr[dragIndex] = { ...arr[dragIndex], x: snap.x, y: snap.y };
		// 重排数组，但保留各自已有 x/y（其它项在拖拽中已被放到目标位）
		const moved = this._moveItem(arr, dragIndex, dragShadowIndex);
		// 拖拽结束：只在“行数变化”时才重新计算高度与上传卡片位置
		const rowsNow = Math.max(1, Math.ceil((moved.length + 1) / this.data.columns));
		if (rowsNow !== this.data.lastLayoutRows) {
			const laid = this._layoutImages(moved);
			this.setData({ images: laid, dragging: false, dragIndex: -1, dragShadowIndex: -1, stitchedTempPath: '' });
		} else {
			this.setData({ images: moved, dragging: false, dragIndex: -1, dragShadowIndex: -1, stitchedTempPath: '' });
		}
	},

	// 删除角标
	onTapDeleteBadge(e) {
		const idx = e.currentTarget.dataset.index;
		const it = this.data.images[idx];
		if (!it) return;
		this.setData({ showDeleteModal: true, modalImage: it.tempFilePath, modalIndex: idx });
	},

	onConfirmDelete() {
		const idx = this.data.modalIndex;
		if (idx < 0) { this.setData({ showDeleteModal: false }); return; }
		const arr = this.data.images.slice();
		const removed = arr.splice(idx, 1);
		this._releaseImages(removed);
		const laid = this._layoutImages(arr);
		this.setData({ images: laid, selectedIndex: -1, showDeleteModal: false, modalImage: '', modalIndex: -1, stitchedTempPath: '', stitchProgress: 0 });
	},

	onCancelDelete() {
		this.setData({ showDeleteModal: false, modalImage: '', modalIndex: -1 });
	},

	// 可选最大图片数（可按需调整）
	MAX_IMAGES: 9,

	onLoad() {
		if (!this._cacheRefs) {
			this._cacheRefs = Object.create(null);
		}
		const info = wx.getSystemInfoSync();
		this._initBitmapCacheBudget(info);
		const pxPerRpx = info.windowWidth / 750;
		const thumbGapPx = Math.round(pxPerRpx * 12);
		// 固定一排展示 3 张缩略图（用户要求由 4 改为 3）
		const columns = 3;
		// 预留左右内边距约 32rpx，让 3 列刚好铺满
		const innerWidth = info.windowWidth - Math.round(pxPerRpx * 32);
		const thumbWpx = Math.max(48, Math.floor((innerWidth - (columns - 1) * thumbGapPx) / columns));
		this.setData({
			canvasPreviewHeight: calcPreviewHeight(info.windowWidth, 3/4),
			thumbWpx,
			thumbGapPx,
			columns,
			thumbsHeight: thumbWpx + thumbGapPx,
		});
		// 初始化布局，确保显示"上传图片"卡片
		const laid = this._layoutImages(this.data.images || []);
		this.setData({ images: laid });
		
		// 检测设备画布上限（异步，用于后续拼图优化）
		this._detectDeviceLimit();
	},
	
	_detectDeviceLimit() {
		const sys = wx.getSystemInfoSync();
		const applyFallback = () => {
			if (!this.deviceMaxCanvasSize) {
				this.deviceMaxCanvasSize = sys.platform === 'ios' ? 12288 : 4096;
			}
			if (!this.deviceMaxCanvasPixels) {
				const side = this.deviceMaxCanvasSize;
				const pixelCap = sys.platform === 'android'
					? side * Math.min(side, 4096)
					: side * Math.min(side, 12288);
				this.deviceMaxCanvasPixels = Math.max(pixelCap, 4096 * 2048);
			}
			console.log('使用平台默认上限', sys.platform, this.deviceMaxCanvasSize, this.deviceMaxCanvasPixels);
		};

		try {
			const stored = wx.getStorageSync && wx.getStorageSync('canvasLimit');
			if (stored && stored.platform === sys.platform && stored.size && stored.pixels) {
				this.deviceMaxCanvasSize = stored.size;
				if (sys.platform === 'ios') {
					const iosLimit = 16384 * 1400;
					this.deviceMaxCanvasPixels = Math.min(stored.pixels, iosLimit);
				} else {
					this.deviceMaxCanvasPixels = stored.pixels;
				}
				console.log('命中缓存画布上限', stored.size, stored.pixels);
				return;
			}
		} catch (e) {}

		// 尝试通过创建临时canvas检测设备真实上限
		const query = wx.createSelectorQuery();
		query.select('#preview').fields({ node: true }).exec((res) => {
			if (!res || !res[0]) { applyFallback(); return; }
			const node = res[0].node;
			const candidates = (sys.platform === 'ios')
				? [16384, 14336, 12288, 11264, 10240, 9216, 8192, 7168, 6144, 5120, 4608, 4096]
				: [8192, 7680, 7168, 6656, 6144, 5632, 5120, 4736, 4352, 4096, 3840, 3584];
			let detected = 0;
			for (const size of candidates) {
				if (this._testCanvasSize(node, size)) {
					detected = size;
					break;
				}
			}
			if (detected) {
				this.deviceMaxCanvasSize = detected;
				let pixelCap;
				if (sys.platform === 'android') {
					pixelCap = detected * Math.min(detected, 8192);
				} else {
					pixelCap = detected * Math.min(detected, 16384);
				}
				if (sys.platform === 'ios') {
					const iosLimit = 16384 * 1400;
					pixelCap = Math.min(pixelCap, iosLimit);
				} else {
					pixelCap = Math.min(pixelCap, 16384 * 8192);
				}
				this.deviceMaxCanvasPixels = pixelCap;
				console.log('检测到2D画布上限', detected, '像素上限', this.deviceMaxCanvasPixels);
				try {
					if (wx.setStorageSync) {
						wx.setStorageSync('canvasLimit', { platform: sys.platform, size: detected, pixels: pixelCap });
					}
				} catch (e) {}
			} else {
				applyFallback();
			}
		});
	},

	_testCanvasSize(node, size) {
		try {
			let off = null;
			if (node && node.createOffscreenCanvas) {
				try {
					off = node.createOffscreenCanvas({ type: '2d', width: size, height: size });
				} catch (err) {}
			}
			if (!off && wx.createOffscreenCanvas) {
				try {
					off = wx.createOffscreenCanvas({ type: '2d', width: size, height: size });
				} catch (err2) {}
			}
			if (!off) return false;
			const ctx = off.getContext && off.getContext('2d');
			if (!ctx) { off = null; return false; }
			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, 2, 2);
			if (ctx.getImageData) {
				ctx.getImageData(0, 0, 1, 1);
			}
			try {
				off.width = 0;
				off.height = 0;
			} catch(e) {}
			return true;
		} catch (e) {
			return false;
		}
	},

	onUnload() {
		this._releaseImages(this.data.images || []);
		this._releaseAllCacheFiles();
		this._clearBitmapCache();
	},

	// 计算并布局缩略图坐标
	_layoutImages(list) {
		const { columns, thumbWpx, thumbGapPx } = this.data;
		const laid = list.map((it, idx) => {
			const col = idx % columns;
			const row = Math.floor(idx / columns);
			return { ...it, x: col * (thumbWpx + thumbGapPx), y: row * (thumbWpx + thumbGapPx) };
		});
		const canAdd = laid.length < this.MAX_IMAGES;
		// 始终为“上传图片”卡片预留一格，以便满额时卡片仍可见（禁用点击）
		const rows = Math.max(1, Math.ceil((laid.length + 1) / columns));
		const thumbsHeight = rows * (thumbWpx + thumbGapPx);
		// 计算上传卡片位置：紧随其后
		const nextIdx = laid.length;
		const ncol = nextIdx % columns;
		const nrow = Math.floor(nextIdx / columns);
		const addX = ncol * (thumbWpx + thumbGapPx);
		const addY = nrow * (thumbWpx + thumbGapPx);
		this.setData({ thumbsHeight, addX, addY, canAdd, lastLayoutRows: rows });
		return laid;
	},

	_moveItem(arr, from, to) {
		if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
		const copy = arr.slice();
		const [it] = copy.splice(from, 1);
		copy.splice(to, 0, it);
		return copy;
	},

	_registerCacheFile(path) {
		if (!path) return;
		if (!this._cacheRefs) this._cacheRefs = Object.create(null);
		this._cacheRefs[path] = (this._cacheRefs[path] || 0) + 1;
	},

	_releaseCacheFile(path) {
		if (!path || !this._cacheRefs) return;
		const current = this._cacheRefs[path] || 0;
		if (!current) return;
		if (current <= 1) {
			delete this._cacheRefs[path];
			if (SAVED_PATH_REG.test(path)) {
				wx.removeSavedFile({ filePath: path, complete: () => {} });
			}
		} else {
			this._cacheRefs[path] = current - 1;
		}
	},

	_releaseImage(info) {
		if (!info) return;
		const path = info.preparedPath || info.tempFilePath;
		if (path) {
			this._releaseBitmapByPath(path);
		}
		if (path && (info._cacheRegistered || SAVED_PATH_REG.test(path))) {
			this._releaseCacheFile(path);
			info._cacheRegistered = false;
		}
	},

	_releaseImages(list) {
		if (!Array.isArray(list)) return;
		list.forEach(it => this._releaseImage(it));
	},

	_releaseAllCacheFiles() {
		if (!this._cacheRefs) return;
		const paths = Object.keys(this._cacheRefs);
		paths.forEach(p => {
			if (this._cacheRefs[p]) {
				wx.removeSavedFile({ filePath: p, complete: () => {} });
			}
		});
		this._cacheRefs = Object.create(null);
	},

	_initBitmapCacheBudget(sysInfo) {
		if (this._bitmapBudgetReady) return;
		let info = sysInfo;
		if (!info) {
			try { info = wx.getSystemInfoSync(); } catch(e) { info = { platform: '' }; }
		}
		const isIOS = info && info.platform === 'ios';
		this._bitmapPixelBudget = isIOS ? IOS_BITMAP_BUDGET : ANDROID_BITMAP_BUDGET;
		this._bitmapCacheLimit = isIOS ? DEFAULT_BITMAP_CACHE_LIMIT : ANDROID_BITMAP_CACHE_LIMIT;
		if (typeof Map === 'function' && !this._bitmapCache) {
			this._bitmapCache = new Map();
		}
		this._bitmapPixelTotal = 0;
		this._bitmapBudgetReady = true;
	},

	_getBitmapFromCache(path) {
		if (!path || !this._bitmapCache || typeof this._bitmapCache.get !== 'function') return null;
		const entry = this._bitmapCache.get(path);
		if (entry && entry.bmp) {
			entry.usedAt = Date.now();
			return entry.bmp;
		}
		return null;
	},

	_storeBitmapInCache(path, bmp) {
		if (!path || !bmp) return;
		if (typeof Map !== 'function') return;
		if (!this._bitmapCache) {
			this._bitmapCache = new Map();
		}
		this._removeBitmapEntry(path);
		const pixels = Math.max(1, (bmp.width || 0)) * Math.max(1, (bmp.height || 0));
		this._bitmapCache.set(path, {
			bmp,
			pixels,
			usedAt: Date.now(),
		});
		this._bitmapPixelTotal = (this._bitmapPixelTotal || 0) + pixels;
		this._trimBitmapCache();
	},

	_removeBitmapEntry(path) {
		if (!path || !this._bitmapCache || typeof this._bitmapCache.get !== 'function') return;
		const entry = this._bitmapCache.get(path);
		if (!entry) return;
		const bmp = entry.bmp;
		if (bmp) {
			try { bmp.onload = null; bmp.onerror = null; } catch(e) {}
			try { bmp.src = ''; } catch(e2) {}
			if (typeof bmp.close === 'function') {
				try { bmp.close(); } catch(e3) {}
			}
		}
		if (entry.pixels) {
			this._bitmapPixelTotal = Math.max(0, (this._bitmapPixelTotal || 0) - entry.pixels);
		}
		this._bitmapCache.delete(path);
	},

	_trimBitmapCache(force = false) {
		if (!this._bitmapCache || typeof this._bitmapCache.entries !== 'function') return;
		const limit = this._bitmapCacheLimit || DEFAULT_BITMAP_CACHE_LIMIT;
		const budget = this._bitmapPixelBudget || IOS_BITMAP_BUDGET;
		if (!force && this._bitmapCache.size <= limit && (this._bitmapPixelTotal || 0) <= budget) return;
		const list = Array.from(this._bitmapCache.entries());
		list.sort((a, b) => {
			const usedA = (a[1] && a[1].usedAt) || 0;
			const usedB = (b[1] && b[1].usedAt) || 0;
			if (usedA !== usedB) return usedA - usedB;
			const pxA = (a[1] && a[1].pixels) || 0;
			const pxB = (b[1] && b[1].pixels) || 0;
			return pxA - pxB;
		});
		for (const [key] of list) {
			if (!force && this._bitmapCache.size <= limit && (this._bitmapPixelTotal || 0) <= budget) break;
			this._removeBitmapEntry(key);
		}
	},

	_releaseBitmapByPath(path) {
		if (!path) return;
		this._removeBitmapEntry(path);
	},

	_clearBitmapCache() {
		if (!this._bitmapCache) return;
		this._trimBitmapCache(true);
		if (typeof this._bitmapCache.clear === 'function') {
			this._bitmapCache.clear();
		}
		this._bitmapPixelTotal = 0;
	},

	async _ensureSavedFile(path) {
		if (!path) throw new Error('invalid path');
		if (SAVED_PATH_REG.test(path)) {
			this._registerCacheFile(path);
			return path;
		}
		return await new Promise((resolve, reject) => {
			wx.saveFile({
				tempFilePath: path,
				success: (res) => {
					const saved = res.savedFilePath || res.filePath;
					if (saved) {
						this._registerCacheFile(saved);
						resolve(saved);
					} else {
						reject(new Error('saveFile 缺少返回路径'));
					}
				},
				fail: reject,
			});
		});
	},

	async _prepareSingleImage(img, index = 0) {
		const cloned = { ...img };
		const originPath = cloned.sourcePath || cloned.tempFilePath;
		let path = cloned.preparedPath || cloned.tempFilePath;
		let info;
		try {
			info = await this._pGetImageInfo(path);
			if (info && info.path) path = info.path;
		} catch (err) {
			console.warn(`图片${index}信息读取失败，尝试转码`, err);
			const conv = await tryTranscodeIfNeeded(path);
			if (!conv || conv === path) {
				throw err;
			}
			path = conv;
			info = await this._pGetImageInfo(path);
		}
		let type = info && info.type ? String(info.type).toLowerCase() : '';
		if (type && !SUPPORTED_IMAGE_TYPES.includes(type)) {
			const conv2 = await tryTranscodeIfNeeded(path);
			if (conv2 && conv2 !== path) {
				path = conv2;
				info = await this._pGetImageInfo(path);
				type = info && info.type ? String(info.type).toLowerCase() : type;
			}
		}
		// 记录文件大小（用于大图策略判断/进度展示）
		let fileSize = 0;
		try {
			const fi = await this._pGetFileInfo(path);
			fileSize = fi && fi.size ? fi.size : 0;
		} catch (e) {}

		const savedPath = await this._ensureSavedFile(path);
		const prepared = {
			...cloned,
			sourcePath: originPath,
			tempFilePath: savedPath,
			preparedPath: savedPath,
			preparedType: type || cloned.type || '',
			naturalWidth: Math.max(1, info && info.width ? info.width : (cloned.naturalWidth || cloned.width || 1)),
			naturalHeight: Math.max(1, info && info.height ? info.height : (cloned.naturalHeight || cloned.height || 1)),
			width: Math.max(1, info && info.width ? info.width : (cloned.width || 1)),
			height: Math.max(1, info && info.height ? info.height : (cloned.height || 1)),
			orientation: info && info.orientation ? info.orientation : (cloned.orientation || 1),
			fileSize,
			prepared: true,
			_cacheRegistered: true,
		};
		return prepared;
	},

	async _prepareImages(list, progressCb) {
		if (!Array.isArray(list) || !list.length) return [];
		const prepared = [];
		const newlyPrepared = [];
		try {
			for (let i = 0; i < list.length; i++) {
				const item = list[i];
				if (item && item.prepared && item.preparedPath && item.naturalWidth && item.naturalHeight) {
					prepared.push(item);
					if (typeof progressCb === 'function') progressCb(i + 1, list.length, item);
					// 让出一帧，避免大图连续处理导致卡顿/闪退
					await this._sleep(0);
					continue;
				}
				const ready = await this._prepareSingleImage(item, i);
				prepared.push(ready);
				newlyPrepared.push(ready);
				if (typeof progressCb === 'function') progressCb(i + 1, list.length, ready);
				await this._sleep(0);
			}
			return prepared;
		} catch (err) {
			this._releaseImages(newlyPrepared);
			throw err;
		}
	},

	// 底栏触发：竖向/横向拼接
	onStitchVertical() {
		if (this.data.isStitching) return;
		if (!(this.data.images || []).length) {
			wx.showToast({ title: '请上传图片后，再进行拼图', icon: 'none' });
			return;
		}
		this.setData({ direction: 'vertical' });
		this.onStitch();
	},
	onStitchHorizontal() {
		if (this.data.isStitching) return;
		if (!(this.data.images || []).length) {
			wx.showToast({ title: '请上传图片后，再进行拼图', icon: 'none' });
			return;
		}
		this.setData({ direction: 'horizontal' });
		this.onStitch();
	},

	// 长按底栏按钮：打开图间距设置
	onLongPressVertical() {
		const mode = this.data.verticalStitchMode || 'min';
		this.setData({ 
			showGapModal: true, 
			gapModalTitle: '竖向拼接设置', 
			gapTemp: Math.min(20, Math.max(0, this.data.gap || 0)),
			modalDirection: 'vertical',
			modeTemp: mode,
			modeLabel1: '最小宽',
			modeLabel2: '最大宽'
		});
		this._updateModeDesc('vertical', mode);
	},
	onLongPressHorizontal() {
		const mode = this.data.horizontalStitchMode || 'min';
		this.setData({ 
			showGapModal: true, 
			gapModalTitle: '横向拼接设置', 
			gapTemp: Math.min(20, Math.max(0, this.data.gap || 0)),
			modalDirection: 'horizontal',
			modeTemp: mode,
			modeLabel1: '最小高',
			modeLabel2: '最大高'
		});
		this._updateModeDesc('horizontal', mode);
	},
	onGapTempChanging(e) {
		const v = e.detail.value || 0; this.setData({ gapTemp: v });
	},
	onGapTempChange(e) {
		const v = e.detail.value || 0; this.setData({ gapTemp: v });
	},
	onCancelGap() { this.setData({ showGapModal: false }); },
	onConfirmGap() {
		const v = Math.min(20, Math.max(0, this.data.gapTemp || 0));
		const mode = this.data.modeTemp || 'min';
		if (this.data.modalDirection === 'vertical') {
			this.setData({ gap: v, verticalStitchMode: mode, showGapModal: false, stitchedTempPath: '', stitchProgress: 0 });
		} else {
			this.setData({ gap: v, horizontalStitchMode: mode, showGapModal: false, stitchedTempPath: '', stitchProgress: 0 });
		}
	},

	// 间距步进与直接输入
	onGapDec() {
		const v = Math.max(0, (this.data.gapTemp || 0) - 1);
		this.setData({ gapTemp: v });
	},
	onGapInc() {
		const v = Math.min(20, (this.data.gapTemp || 0) + 1);
		this.setData({ gapTemp: v });
	},
	onGapNumberTap() {
		this.setData({ gapInputFocus: true });
	},
	onGapInputFocus() {
		// 聚焦时不做处理，保持焦点
	},
	onGapInputBlur(e) {
		let v = Number(e.detail.value);
		if (Number.isNaN(v)) v = this.data.gapTemp || 0;
		v = Math.min(20, Math.max(0, Math.round(v)));
		this.setData({ gapTemp: v, gapInputFocus: false });
	},
	onGapInputConfirm(e) {
		this.onGapInputBlur(e);
	},

	onSelectMode(e) {
		const mode = e.currentTarget.dataset.mode || 'min';
		this.setData({ modeTemp: mode });
		this._updateModeDesc(this.data.modalDirection, mode);
	},

	_updateModeDesc(direction, mode) {
		let lines = [];
		if (direction === 'vertical') {
			if (mode === 'min') {
				lines = ['✓ 清晰度：最佳（不放大）', '✓ 文件大小：较小', '✓ 特点: 缩小大图，适用于多图轻量化保存'];
			} else if (mode === 'max') {
				lines = ['✓ 清晰度：可能略降（放大）', '⚠ 文件大小：较大', '✓ 特点: 扩大小图, 适用于打印或高清保存'];
			} else {
				lines = ['✓ 清晰度：原画保真（原图）',  '⚠ 文件大小：较大', '✓ 特点: 不对图片放缩，适用于保存原图'];
			}
		} else {
			if (mode === 'min') {
				lines = ['✓ 清晰度：最佳（不放大）', '✓ 文件大小：较小', '✓ 特点: 缩小大图，适用于多图轻量化保存'];
			} else if (mode === 'max') {
				lines = ['✓ 清晰度：可能略降（放大）', '⚠ 文件大小：较大', '✓ 特点: 扩大小图, 适用于打印或高清保存'];
			} else {
				lines = ['✓ 清晰度：原画保真（原图）',  '⚠ 文件大小：较大', '✓ 特点: 不对图片放缩，适用于保存原图'];
			}
		}
		this.setData({ modeDescLines: lines });
	},

	// 双击温馨提示隐藏/显示
	onTipsTap() {
		const now = Date.now();
		const last = this.data._lastTipsTap || 0;
		if (now - last < 500) {
			this.setData({ tipsTransparent: !this.data.tipsTransparent, _lastTipsTap: 0 });
		} else {
			this.setData({ _lastTipsTap: now });
		}
	},

	// 空白区域双击：当温馨提示隐藏时可恢复显示
	onBlankTap() {
		if (this.data.showTips) return;
		const now = Date.now();
		const last = this.data._lastBlankTap || 0;
		if (now - last < 500) {
			this.setData({ showTips: true, _lastBlankTap: 0 });
		} else {
			this.setData({ _lastBlankTap: now });
		}
	},

	_getXYByIndex(index) {
		const { columns, thumbWpx, thumbGapPx } = this.data;
		const cell = thumbWpx + thumbGapPx;
		const col = index % columns; const row = Math.floor(index / columns);
		return { x: col * cell, y: row * cell };
	},

	_updateThumbsHeightByLength(len) {
		const { columns, thumbWpx, thumbGapPx } = this.data;
		const rows = Math.max(1, Math.ceil(len / columns));
		this.setData({ thumbsHeight: rows * (thumbWpx + thumbGapPx) });
	},

	// 计算落点索引（以缩略图中心所在格为准）
	_computeCellIndex(x, y) {
		const { columns, thumbWpx, thumbGapPx, images } = this.data;
		const cell = thumbWpx + thumbGapPx;
		const cx = x + thumbWpx / 2;
		const cy = y + thumbWpx / 2;
		let col = Math.floor(cx / cell);
		let row = Math.floor(cy / cell);
		if (col < 0) col = 0; if (col >= columns) col = columns - 1;
		let to = row * columns + col;
		if (to < 0) to = 0; if (to >= images.length) to = images.length - 1;
		return to;
	},

	// 根据占位索引实时给非拖拽项设置目标坐标（不改变数组顺序）
	_withShadowPositions(images, dragIndex, shadowIndex) {
		const { columns, thumbWpx, thumbGapPx } = this.data;
		const cell = thumbWpx + thumbGapPx;
		const getXY = (idx) => {
			const col = idx % columns; const row = Math.floor(idx / columns);
			return { x: col * cell, y: row * cell };
		};
		const result = images.map((it, idx) => ({ ...it }));
		for (let i = 0; i < result.length; i++) {
			if (i === dragIndex) continue; // 拖拽项由 onDragMoving 直接设置 x/y
			let logicalIndex = i;
			if (dragIndex < shadowIndex && i > dragIndex && i <= shadowIndex) logicalIndex = i - 1;
			else if (dragIndex > shadowIndex && i >= shadowIndex && i < dragIndex) logicalIndex = i + 1;
			const pos = getXY(logicalIndex);
			result[i].x = pos.x; result[i].y = pos.y;
		}
		return result;
	},

	// 回调封装，兼容不支持 Promise 的基础库
	_pChooseImage(opts) {
		return new Promise((resolve, reject) => wx.chooseImage({
			...opts,
			success: resolve,
			fail: reject,
		}));
	},

	_pGetImageInfo(src) {
		return new Promise((resolve, reject) => wx.getImageInfo({
			src,
			success: resolve,
			fail: reject,
		}));
	},

	_pGetFileInfo(filePath) {
		return new Promise((resolve) => {
			try {
				const fsm = wx.getFileSystemManager && wx.getFileSystemManager();
				if (!fsm || !fsm.getFileInfo) { resolve(null); return; }
				fsm.getFileInfo({
					filePath,
					success: resolve,
					fail: () => resolve(null),
				});
			} catch (e) {
				resolve(null);
			}
		});
	},

	_sleep(ms) {
		return new Promise((r) => setTimeout(r, ms));
	},

	// 统一封装：chooseMedia（备用方案）
	_pChooseMedia(opts) {
		return new Promise((resolve, reject) => wx.chooseMedia({
			...opts,
			success: resolve,
			fail: reject,
		}));
	},

	// 统一封装：chooseMessageFile（开发者工具上更稳定）
	_pChooseMessageFile(opts) {
		return new Promise((resolve, reject) => wx.chooseMessageFile({
			...opts,
			success: resolve,
			fail: reject,
		}));
	},

	// 选择图片：追加到现有列表；开发者工具优先 chooseMessageFile；失败转码兜底
	onChooseImages: async function() {
    try {
			const sys = wx.getSystemInfoSync();
			let files = [];
			let cancelled = false;
			// 剩余可添加数量；开发者工具常见“单选”限制，通过多次点击实现“多选叠加”
			const remain = Math.max(0, this.MAX_IMAGES - (this.data.images ? this.data.images.length : 0));
			if (remain <= 0) {
				wx.showToast({ title: `最多选择${this.MAX_IMAGES}张`, icon: 'none' });
				return;
			}
			// 1) 开发者工具优先使用 chooseMessageFile
			if (sys.platform === 'devtools') {
				try {
					const r = await this._pChooseMessageFile({ count: remain, type: 'image', extension: ['jpg','jpeg','png','webp','heic','heif'] });
					files = (r.tempFiles || []).map(f => ({ tempFilePath: f.path }));
				} catch (e1) { if ((e1 && e1.errMsg || '').includes('cancel')) { cancelled = true; } console.warn('chooseMessageFile失败', e1); }
			}
			// 2) 常规环境使用 chooseImage
			if (!files.length && !cancelled) {
				try {
					// 为了拼图清晰度：优先只拿原图，避免“选图阶段”就被压缩导致整体变糊
					const r = await this._pChooseImage({ count: remain, sizeType: ['original'], sourceType: ['album','camera'] });
					if (r.tempFiles && r.tempFiles.length) {
						files = r.tempFiles.map(f => ({ tempFilePath: f.tempFilePath || f.path }));
					} else {
						files = (r.tempFilePaths || []).map(p => ({ tempFilePath: p }));
					}
				} catch (e2) { if ((e2 && e2.errMsg || '').includes('cancel')) { cancelled = true; } console.warn('chooseImage失败', e2); }
			}
			// 3) 兜底使用 chooseMedia
			if (!files.length && !cancelled) {
				try {
					// 同上：只拿原图
					const r = await this._pChooseMedia({ count: remain, mediaType: ['image'], sizeType: ['original'], sourceType: ['album','camera'] });
					files = (r.tempFiles || []).map(f => ({ tempFilePath: f.tempFilePath, width: f.width, height: f.height }));
				} catch (e3) { if ((e3 && e3.errMsg || '').includes('cancel')) { cancelled = true; } console.warn('chooseMedia失败', e3); }
			}

			if (cancelled || !files.length) { return; }
        const detail = [];
        for (const f of files) {
				let path = f.tempFilePath;
				if (!path) { continue; }
				let info;
				// 若 chooseMedia 已返回宽高，直接使用，减少对 getImageInfo 依赖
				if (f && f.width && f.height) {
					info = { width: f.width, height: f.height, type: '', orientation: 1 };
				} else {
					// 某些 HEIC/LivePhoto 可能直接 getImageInfo 失败，做两级兜底
				try {
					info = await this._pGetImageInfo(path);
				} catch (e) {
						try {
					path = await tryTranscodeIfNeeded(path);
					info = await this._pGetImageInfo(path);
						} catch (e2) {
							// 最终兜底：保留路径，宽高暂缺，方向按 1 处理，避免整体失败
							info = { width: 0, height: 0, type: '', orientation: 1 };
						}
					}
				}
            detail.push({
					tempFilePath: path,
                width: info.width,
                height: info.height,
                type: info.type,
                orientation: info.orientation
            });
        }
        // 追加到现有列表后去重，并限制到 MAX_IMAGES
        const existed = this.data.images ? this.data.images.slice() : [];
        const merged = existed.concat(detail);
        const seen = Object.create(null);
        const dedup = [];
        for (const it of merged) {
            if (!seen[it.tempFilePath]) {
                seen[it.tempFilePath] = 1;
                dedup.push(it);
            }
            if (dedup.length >= this.MAX_IMAGES) break;
        }
		// 体验优化：用户选择完图片后立刻显示进度遮罩（不再等待统计完成）
		this.setData({
			isPreparing: true,
			prepareProgress: 1,
			prepareNote: '正在准备图片…',
			prepareTotalMB: 0,
		});

		// 统计图片总大小：仅用于展示与策略判断，不阻塞遮罩出现
		let totalBytes = 0;
		for (const it of dedup) {
			const p = it && it.tempFilePath;
			if (!p) continue;
			if (it.fileSize) { totalBytes += it.fileSize; continue; }
			try {
				const fi = await this._pGetFileInfo(p);
				if (fi && fi.size) totalBytes += fi.size;
			} catch (e) {}
		}
		const totalMB = Math.round((totalBytes / (1024 * 1024)) * 10) / 10;
		this.setData({ prepareTotalMB: totalMB });
		let preparedList;
		try {
			preparedList = await this._prepareImages(dedup, (done, total) => {
				const pct = Math.min(99, Math.max(1, Math.round((done / total) * 100)));
				this.setData({
					prepareProgress: pct,
					prepareNote: `正在加载图片 ${done}/${total}`,
				});
			});
		} finally {
			this.setData({ isPreparing: false, prepareProgress: 0, prepareNote: '', prepareTotalMB: 0 });
		}
		const laid = this._layoutImages(preparedList);
		this.setData({ images: laid, stitchedTempPath: '', stitchProgress: 0 });
    } catch (e) {
			const msg = (e && e.errMsg || '').includes('cancel') ? '已取消' : '选择失败';
			wx.showToast({ title: msg, icon: 'none' });
    }
},

	onToggleDirection(e) {
		this.setData({ direction: e.detail.value ? 'vertical' : 'horizontal', stitchedTempPath: '', stitchProgress: 0 });
	},

	onGapChange(e) {
		this.setData({ gap: e.detail.value || 0, stitchedTempPath: '', stitchProgress: 0 });
	},

onGapChanging(e) {
		this.setData({ gap: e.detail.value || 0, stitchedTempPath: '', stitchProgress: 0 });
},

	onStitch: async function() {
	const { direction, gap } = this.data;
	const originalImages = this.data.images ? this.data.images.map(it => ({ ...it })) : [];
	if (!originalImages.length) return;
	let images = originalImages;
  
	// 复位
	this.setData({ isStitching: true, stitchProgress: 1, stitchedTempPath: '' });
  
		const query = wx.createSelectorQuery();
		query.select('#preview').fields({ node: true, size: true }).exec(async (res) => {
			const node = res[0].node;
			const size = res[0];
	  const sys = wx.getSystemInfoSync();
	  const dpr = Math.max(1, sys.pixelRatio || 1);
  
	  // 强制重新初始化主画布（清除之前可能的状态残留）
			const { ctx } = createHighResCanvas(node, size.width, size.height);

	  // 用于追踪需要释放的资源
	  let off = null;
	  let usedMain = false;
	  let dataDirty = false;
	  // 大任务可靠性优先：禁用位图缓存、禁用超采样、逐张强制 flush 后再释放，避免“黑白渐变块”
	  const totalBytes = (images || []).reduce((s, it) => s + (it && it.fileSize ? it.fileSize : 0), 0);
	  const bigTask = (images && images.length >= 8) || totalBytes >= 30 * 1024 * 1024;
	  const noCacheInThisStitch = !!bigTask;
	  if (noCacheInThisStitch) {
		try { this._clearBitmapCache(); } catch(e) {}
	  }
  
	  try {
		// 1) 确保图片已预处理并具备稳定路径与尺寸
		let doneProbe = 0;
		for (let idx = 0; idx < images.length; idx++) {
		  let current = images[idx];
		  if (!current || !current.prepared || !current.preparedPath || !current.naturalWidth || !current.naturalHeight) {
                        try {
			  const prepared = await this._prepareSingleImage(current || {}, idx);
			  images[idx] = prepared;
			  current = prepared;
			  dataDirty = true;
			} catch (pe) {
			  console.warn(`图片${idx}预处理失败，尝试继续`, pe);
			  const fallback = current || {};
			  fallback.naturalWidth = Math.max(1, fallback.naturalWidth || fallback.width || 1);
			  fallback.naturalHeight = Math.max(1, fallback.naturalHeight || fallback.height || 1);
			  images[idx] = fallback;
			  current = fallback;
			  dataDirty = true;
			}
		  } else {
			current.naturalWidth = Math.max(1, current.naturalWidth || current.width || 1);
			current.naturalHeight = Math.max(1, current.naturalHeight || current.height || 1);
		  }
		  doneProbe++;
		  const p = Math.min(25, Math.round(1 + (doneProbe / images.length) * 24));
		  this.setData({ stitchProgress: p });
                }

		// 2) 计算目标（输出）尺寸 —— 基于天然像素，根据拼接方式确定
		const allW = images.map(i => i.naturalWidth || i.width || 0).filter(n => n > 0);
		const allH = images.map(i => i.naturalHeight || i.height || 0).filter(n => n > 0);
                if (!allW.length || !allH.length) throw new Error('图片尺寸不可用');
  
		const gapPx = gap || 0;
		const mode = (direction === 'vertical' ? this.data.verticalStitchMode : this.data.horizontalStitchMode) || 'min';
		console.log('拼接参数', { direction, mode, gapPx });
		
                let outW = 0, outH = 0;
                if (direction === 'vertical') {
		  if (mode === 'min') {
			// 最小宽：以最小宽为基准等比缩小
                    outW = Math.min.apply(null, allW);
			outH = images.reduce((sum, i, idx) => {
			  const iw = Math.max(1, i.naturalWidth || i.width || 1);
			  const ih = Math.max(1, i.naturalHeight || i.height || 1);
			  const drawH = ih * (outW / iw);
			  return sum + drawH + (idx ? gapPx : 0);
			}, 0);
		  } else if (mode === 'max') {
			// 最大宽：以最大宽为基准等比放大
			outW = Math.max.apply(null, allW);
			outH = images.reduce((sum, i, idx) => {
			  const iw = Math.max(1, i.naturalWidth || i.width || 1);
			  const ih = Math.max(1, i.naturalHeight || i.height || 1);
			  const drawH = ih * (outW / iw);
			  return sum + drawH + (idx ? gapPx : 0);
			}, 0);
                } else {
			// 原尺寸：保留原图，以最宽为画布宽度，居中对齐
			outW = Math.max.apply(null, allW);
			outH = images.reduce((sum, i, idx) => {
			  const ih = Math.max(1, i.naturalHeight || i.height || 1);
			  return sum + ih + (idx ? gapPx : 0);
			}, 0);
		  }
                } else {
		  if (mode === 'min') {
			// 最小高：以最小高为基准等比缩小
                    outH = Math.min.apply(null, allH);
			outW = images.reduce((sum, i, idx) => {
			  const iw = Math.max(1, i.naturalWidth || i.width || 1);
			  const ih = Math.max(1, i.naturalHeight || i.height || 1);
			  const drawW = iw * (outH / ih);
			  return sum + drawW + (idx ? gapPx : 0);
			}, 0);
		  } else if (mode === 'max') {
			// 最大高：以最大高为基准等比放大
			outH = Math.max.apply(null, allH);
			outW = images.reduce((sum, i, idx) => {
			  const iw = Math.max(1, i.naturalWidth || i.width || 1);
			  const ih = Math.max(1, i.naturalHeight || i.height || 1);
			  const drawW = iw * (outH / ih);
			  return sum + drawW + (idx ? gapPx : 0);
			}, 0);
		  } else {
			// 原尺寸：保留原图，以最高为画布高度，居中对齐
			outH = Math.max.apply(null, allH);
			outW = images.reduce((sum, i, idx) => {
			  const iw = Math.max(1, i.naturalWidth || i.width || 1);
			  return sum + iw + (idx ? gapPx : 0);
			}, 0);
                }
		}
  
		// 最终确保输出像素为整数
		outW = Math.max(1, Math.round(outW));
		outH = Math.max(1, Math.round(outH));
                if (!outW || !outH) throw new Error('输出尺寸计算失败');
		console.log('计算后尺寸', { outW, outH, mode });
		
		// 限制画布最大尺寸（动态检测设备上限，安卓/iOS区分）
		const sys = wx.getSystemInfoSync();
		const MAX_CANVAS_SIDE = this.deviceMaxCanvasSize || (sys.platform === 'android' ? 4096 : 12288);
		let MAX_TOTAL_PIXELS;
		if (sys.platform === 'ios') {
			const iosLimit = 16384 * 1400;
			MAX_TOTAL_PIXELS = Math.min(this.deviceMaxCanvasPixels || iosLimit, iosLimit);
		} else if (sys.platform === 'android') {
			const androidLimit = MAX_CANVAS_SIDE * Math.min(MAX_CANVAS_SIDE, 8192);
			MAX_TOTAL_PIXELS = Math.min(this.deviceMaxCanvasPixels || androidLimit, androidLimit);
		} else {
			const generalLimit = MAX_CANVAS_SIDE * MAX_CANVAS_SIDE;
			MAX_TOTAL_PIXELS = Math.min(this.deviceMaxCanvasPixels || generalLimit, generalLimit);
		}
		let scaleDown = 1;
		
		// 检查边长限制
		if (outW > MAX_CANVAS_SIDE || outH > MAX_CANVAS_SIDE) {
			scaleDown = Math.min(MAX_CANVAS_SIDE / outW, MAX_CANVAS_SIDE / outH);
		}
		
		// 检查总像素限制
		const totalPixels = outW * outH;
		if (totalPixels > MAX_TOTAL_PIXELS) {
			const pixelScale = Math.sqrt(MAX_TOTAL_PIXELS / totalPixels);
			scaleDown = Math.min(scaleDown, pixelScale);
		}
		
		if (scaleDown < 1) {
			outW = Math.max(1, Math.floor(outW * scaleDown));
			outH = Math.max(1, Math.floor(outH * scaleDown));
			console.log('画布超限，平台', sys.platform, '上限', MAX_CANVAS_SIDE, '缩放比例', scaleDown.toFixed(3), '最终尺寸', outW, 'x', outH, '=', (outW*outH/1000000).toFixed(1), 'M像素');
		} else {
			console.log('画布未超限，使用原始尺寸', outW, 'x', outH, '=', (outW*outH/1000000).toFixed(1), 'M像素');
		}
		this.setData({ stitchProgress: 30 });

		const targetW = outW;
		const targetH = outH;
		const basePixels = targetW * targetH;
		const MAX_SUPER_SAMPLE = noCacheInThisStitch ? 1 : (sys.platform === 'ios' ? 2.2 : 2.6);
		let superSample = 1;
		if (basePixels > 0 && basePixels < MAX_TOTAL_PIXELS) {
			const ratio = Math.sqrt(MAX_TOTAL_PIXELS / basePixels);
			if (ratio > 1.01) {
				const sideCap = Math.min(MAX_CANVAS_SIDE / targetW, MAX_CANVAS_SIDE / targetH);
				superSample = Math.min(MAX_SUPER_SAMPLE, ratio, sideCap);
			}
		}
		if (!Number.isFinite(superSample) || superSample < 1) superSample = 1;
		let canvasOutW = Math.max(1, Math.round(targetW * superSample));
		let canvasOutH = Math.max(1, Math.round(targetH * superSample));
		// 再次兜底：避免四舍五入后超出像素上限（iOS 导出 buffer 限制更敏感）
		let guard = 0;
		while (canvasOutW * canvasOutH > MAX_TOTAL_PIXELS && guard < 20) {
			superSample *= 0.96;
			if (superSample < 1) { superSample = 1; break; }
			canvasOutW = Math.max(1, Math.floor(targetW * superSample));
			canvasOutH = Math.max(1, Math.floor(targetH * superSample));
			guard++;
		}
		if (superSample > 1) {
			console.log('启用超采样', superSample.toFixed(2), '画布尺寸', canvasOutW, 'x', canvasOutH);
		}

		// 3) 创建离屏画布（直接用逻辑像素，安卓可能需要回退主画布）
		let octx;
		try {
			off = safeCreateOffscreenCanvas(node, canvasOutW, canvasOutH);
			octx = off.getContext('2d');
			console.log('离屏画布创建成功', canvasOutW, canvasOutH);
		} catch (eOff) {
			console.warn('离屏画布创建失败，回退主画布', eOff);
			usedMain = true;
			off = null;
			// 临时设置主画布为输出尺寸
			node.width = canvasOutW;
			node.height = canvasOutH;
			octx = node.getContext('2d');
			// 重置变换矩阵为单位矩阵，避免之前的scale残留
			if (octx.setTransform) {
				octx.setTransform(1, 0, 0, 1, 0, 0);
			} else if (octx.resetTransform) {
				octx.resetTransform();
			}
			console.log('使用主画布', canvasOutW, canvasOutH);
		}
		
		if (!octx) {
			throw new Error('无法获取绘图上下文');
		}
		
		// 启用高质量图像平滑，提升缩放清晰度
		if (octx.imageSmoothingEnabled !== undefined) {
			octx.imageSmoothingEnabled = true;
		}
		if (octx.imageSmoothingQuality !== undefined) {
			try { octx.imageSmoothingQuality = 'high'; } catch(e) {}
		}
		
				octx.fillStyle = '#ffffff';
		octx.fillRect(0, 0, canvasOutW, canvasOutH);

		if (superSample !== 1) {
			octx.scale(superSample, superSample);
		}

		// 4) 绘制每张图片，根据拼接方式计算位置与尺寸
		// 不做 round，避免多次累计误差导致“逐张偏移/锯齿缝”
		const scaledGap = gapPx * scaleDown;
				let cursorX = 0, cursorY = 0;
		
		// 安卓离屏画布加载临时文件慢/不稳定，统一用主画布加载（快速且稳定）
		const isAndroid = sys.platform === 'android';
		const baseTimeout = noCacheInThisStitch ? (isAndroid ? 9000 : 9000) : (isAndroid ? 3000 : 4000);
		
				for (let idx = 0; idx < images.length; idx++) {
					const img = images[idx];
		  let filePath = img.preparedPath || img.tempFilePath;
		  let bmp = noCacheInThisStitch ? null : this._getBitmapFromCache(filePath);
		  console.log(`开始加载图片${idx}`, filePath);
		  
		  if (!bmp) {
			const preferSaved = isAndroid && SAVED_PATH_REG.test(filePath);
			const timeout = preferSaved ? 6500 : baseTimeout;
			const preferGlobal = preferSaved;
			try {
			  // 安卓统一用主画布加载（避免离屏画布加载临时文件超时）
			  if (isAndroid) {
				bmp = await loadImageFrom(node, filePath, { timeout, preferGlobal });
				console.log(`图片${idx}主画布加载成功`);
			  } else {
				// iOS优先尝试离屏画布
				try {
				  bmp = await loadImageFrom(usedMain ? node : off, filePath, { timeout, preferGlobal });
				  console.log(`图片${idx}加载成功`);
                    } catch (err) {
				  console.warn(`图片${idx}离屏加载失败，用主画布`, err);
				  bmp = await loadImageFrom(node, filePath, { timeout, preferGlobal });
				}
			  }
                    } catch (err) {
			  // 加载失败，尝试转码
			  console.warn(`加载图片${idx}失败，尝试转码`, err);
			  const convPath = await tryTranscodeIfNeeded(filePath);
			  try { 
				const alreadySaved = SAVED_PATH_REG.test(convPath);
				let savedConv;
				if (alreadySaved) {
				  savedConv = convPath;
				} else {
				  savedConv = await this._ensureSavedFile(convPath);
				}
				if (img._cacheRegistered && img.preparedPath && img.preparedPath !== savedConv) {
				  this._releaseCacheFile(img.preparedPath);
				  img._cacheRegistered = false;
				}
				if (!img._cacheRegistered) {
				  if (alreadySaved) {
					this._registerCacheFile(savedConv);
				  }
				  img._cacheRegistered = true;
				}
				this._releaseBitmapByPath(filePath);
				img.tempFilePath = savedConv;
				img.preparedPath = savedConv;
				img.prepared = true;
				filePath = savedConv;
				dataDirty = true;
				try {
				  const infoNew = await this._pGetImageInfo(savedConv);
				  if (infoNew) {
					img.naturalWidth = Math.max(1, infoNew.width || img.naturalWidth || 1);
					img.naturalHeight = Math.max(1, infoNew.height || img.naturalHeight || 1);
					img.width = img.naturalWidth;
					img.height = img.naturalHeight;
					img.orientation = infoNew.orientation || img.orientation || 1;
					img.preparedType = (infoNew.type || '').toLowerCase();
				  }
				} catch (metaErr) {
				  console.warn(`图片${idx}转码后获取信息失败`, metaErr);
				}
				bmp = await loadImageFrom(node, filePath, { timeout, preferGlobal });
				console.log(`图片${idx}转码后加载成功`);
                        } catch (e) {
				throw new Error(`图片${idx}加载失败: ${e.message || e.errMsg || 'unknown'}`);
			  }
			}
			// 解码兜底：部分机型在内存压力下可能返回异常位图，直接触发重试/转码
			if (!bmp || !bmp.width || !bmp.height) {
				throw new Error(`图片${idx}解码异常`);
			}
			if (!noCacheInThisStitch) {
				this._storeBitmapInCache(filePath, bmp);
			}
		  } else {
			console.log(`图片${idx}使用缓存位图`);
		  }

		  const naturalW = Math.max(1, img.naturalWidth || img.width || bmp.width);
		  const naturalH = Math.max(1, img.naturalHeight || img.height || bmp.height);
		  console.log(`开始绘制图片${idx}`, { naturalW, naturalH, cursorX, cursorY });

					if (direction === 'vertical') {
			if (mode === 'original') {
			  // 原尺寸：保留原图宽高，按scaleDown缩放，左右居中
			  const dw = Math.round(naturalW * scaleDown);
			  const dh = Math.round(naturalH * scaleDown);
			  const dx = Math.floor((outW - dw) / 2);
			  drawWithOrientation(octx, bmp, 0, 0, bmp.width, bmp.height, dx, cursorY, dw, dh, img.orientation);
			  cursorY += dh + scaledGap;
			} else {
			  // min/max：宽度=outW，高度按原图比例
			  const drawH = Math.round(naturalH * (outW / naturalW));
						drawWithOrientation(octx, bmp, 0, 0, bmp.width, bmp.height, 0, cursorY, outW, drawH, img.orientation);
			  cursorY += drawH + scaledGap;
			}
					} else {
			if (mode === 'original') {
			  // 原尺寸：保留原图宽高，按scaleDown缩放，上下居中
			  const dw = Math.round(naturalW * scaleDown);
			  const dh = Math.round(naturalH * scaleDown);
			  const dy = Math.floor((outH - dh) / 2);
			  drawWithOrientation(octx, bmp, 0, 0, bmp.width, bmp.height, cursorX, dy, dw, dh, img.orientation);
			  cursorX += dw + scaledGap;
					} else {
			  // min/max：高度=outH，宽度按原图比例
			  const drawW = Math.round(naturalW * (outH / naturalH));
						drawWithOrientation(octx, bmp, 0, 0, bmp.width, bmp.height, cursorX, 0, drawW, outH, img.orientation);
			  cursorX += drawW + scaledGap;
					}
				}

		  const p2 = 30 + Math.round(((idx + 1) / images.length) * 60);
		  this.setData({ stitchProgress: Math.min(90, p2) });

		  // 大任务：drawImage 可能是延迟提交的；先做一次极小采样触发 flush，再释放图片对象
		  if (noCacheInThisStitch && bmp) {
			try {
				if (octx && octx.getImageData) {
					// 1x1 采样，尽量触发渲染管线落盘（比整图 getImageData 便宜很多）
					octx.getImageData(0, 0, 1, 1);
				}
			} catch(e0) {}
			await this._sleep(0);
			try { bmp.onload = null; bmp.onerror = null; } catch(e) {}
			try { bmp.src = ''; } catch(e2) {}
			if (typeof bmp.close === 'function') { try { bmp.close(); } catch(e3) {} }
		  }
		}
  
		// 5) 导出
		console.log('开始导出', usedMain ? '主画布' : '离屏画布');
		// 为了清晰度：如果启用了超采样，优先导出超采样后的高分辨率（避免再次缩放导致变糊）
		const exportW = canvasOutW;
		const exportH = canvasOutH;
		const tempPath = await safeCanvasToTempFilePath(usedMain ? node : off, 'png', canvasOutW, canvasOutH, exportW, exportH);
		console.log('导出成功', tempPath.tempFilePath);
		this.setData({ stitchProgress: 96 });

		// 6) 清理资源：释放离屏画布（如果有）
		if (off && !usedMain) {
			try {
				// 尝试清理离屏画布（某些环境支持显式释放）
				if (off.width) off.width = 0;
				if (off.height) off.height = 0;
			} catch(e) {}
			off = null;
		}

		// 7) 恢复主画布预览尺寸
		createHighResCanvas(node, size.width, size.height);
		const { ctx: newCtx } = createHighResCanvas(node, size.width, size.height);

		// 8) 预览绘制
				const previewBmp = await loadImageFrom(node, tempPath.tempFilePath);
		newCtx.clearRect(0, 0, size.width, size.height);
		const scaleFit = Math.min(size.width / exportW, size.height / exportH);
		const pvW = Math.round(exportW * scaleFit);
		const pvH = Math.round(exportH * scaleFit);
		newCtx.drawImage(previewBmp, 0, 0, exportW, exportH, (size.width - pvW) / 2, (size.height - pvH) / 2, pvW, pvH);
		// 预览绘制后尽快释放，降低内存峰值
		try { previewBmp.onload = null; previewBmp.onerror = null; } catch(e) {}
		try { previewBmp.src = ''; } catch(e2) {}
		if (previewBmp && typeof previewBmp.close === 'function') {
			try { previewBmp.close(); } catch(e3) {}
		}

		const finalSet = { stitchedTempPath: tempPath.tempFilePath, stitchProgress: 100, isStitching: false };
		if (dataDirty) {
			finalSet.images = images;
		}
		this.setData(finalSet);
		console.log('拼图完成');
		wx.previewImage({ current: tempPath.tempFilePath, urls: [tempPath.tempFilePath] });
			} catch (err) {
                console.error('拼图失败', err);
                const msg = err && (err.errMsg || err.message) ? ('拼图失败：' + (err.errMsg || err.message)) : '拼图失败';
                wx.showToast({ title: msg, icon: 'none' });
		this.setData({ isStitching: false, stitchProgress: 0 });
		// 确保主画布恢复
		try { createHighResCanvas(node, size.width, size.height); } catch(e) {}
	  } finally {
		// 最终清理
		if (off && !usedMain) {
			try { if (off.width) { off.width = 0; off.height = 0; } } catch(e) {}
			off = null;
		}
			}
		});
	},

	onSave: async function() {
		const { stitchedTempPath } = this.data;
		if (!stitchedTempPath) return;
		try {
			await wx.saveImageToPhotosAlbum({ filePath: stitchedTempPath });
			wx.showToast({ title: '已保存到相册', icon: 'success' });
		} catch (e) {
			if (e && e.errMsg && e.errMsg.includes('auth')) {
				wx.openSetting({});
			} else {
				wx.showToast({ title: '保存失败', icon: 'none' });
			}
		}
	},

	// 点击拼图预览：系统预览大图
	onTapPreview() {
		const { stitchedTempPath, isStitching } = this.data;
		if (isStitching || !stitchedTempPath) return;
		wx.previewImage({ current: stitchedTempPath, urls: [stitchedTempPath] });
	},

	// 长按拼图预览：弹框询问保存
	onLongPressPreview() {
		const { stitchedTempPath, isStitching } = this.data;
		if (isStitching || !stitchedTempPath) return;
		wx.showModal({
			title: '是否保存到相册',
			content: '保存后可在系统相册查看与分享',
			confirmText: '保存到相册',
			cancelText: '不用保存',
			success: (res) => {
				if (res.confirm) this.onSave();
			}
		});
	},

	onSelectImage(e) {
		const idx = e.currentTarget.dataset.index;
		this.setData({ selectedIndex: idx });
	},

	// 点击缩略图：预览原图
	onTapThumb(e) {
		if (this.data.dragging) return; // 正在拖拽时忽略点击
		const idx = e.currentTarget.dataset.index;
		if (this.data.multiSelectMode) {
			this._toggleSelectByIndex(idx);
			return;
		}
		const urls = (this.data.images || []).map(it => it.tempFilePath);
		if (!urls.length) return;
		wx.previewImage({ current: urls[idx], urls });
		this.setData({ selectedIndex: idx });
	},

	// 点击上传卡片
	onTapAdd() {
		if ((this.data.images || []).length >= this.MAX_IMAGES) {
			wx.showToast({ title: `最多选择${this.MAX_IMAGES}张`, icon: 'none' });
			return;
		}
		this.onChooseImages();
	},

	// 长按进入多选模式
	onLongPressThumb(e) {
		if (this.data.multiSelectMode) return;
		const imgs = (this.data.images || []).map(it => ({ ...it, selected: false }));
		this.setData({ images: imgs, multiSelectMode: true, selectedCount: 0 });
	},

	// 角标/缩略图点击：切换选中
	onToggleSelect(e) {
		const idx = e.currentTarget.dataset.index;
		this._toggleSelectByIndex(idx);
	},
	_toggleSelectByIndex(idx) {
		const imgs = this.data.images.slice();
		if (!imgs[idx]) return;
		imgs[idx].selected = !imgs[idx].selected;
		const selectedCount = imgs.filter(it => it.selected).length;
		this.setData({ images: imgs, selectedCount });
	},

	onCancelSelect() {
		const imgs = (this.data.images || []).map(it => ({ ...it, selected: false }));
		this.setData({ images: imgs, multiSelectMode: false, selectedCount: 0 });
	},

	onDeleteSelected() {
		const all = this.data.images || [];
		const removed = all.filter(it => it.selected);
		const kept = all.filter(it => !it.selected);
		this._releaseImages(removed);
		const laid = this._layoutImages(kept);
		this.setData({ images: laid, multiSelectMode: false, selectedCount: 0, selectedIndex: -1, stitchedTempPath: '' });
	},

	onMoveLeft() {
		const { images, selectedIndex } = this.data;
		if (selectedIndex <= 0) return;
		const arr = images.slice();
		[arr[selectedIndex - 1], arr[selectedIndex]] = [arr[selectedIndex], arr[selectedIndex - 1]];
		const laid = this._layoutImages(arr);
		this.setData({ images: laid, selectedIndex: selectedIndex - 1, stitchedTempPath: '', stitchProgress: 0 });
	},

	onMoveRight() {
		const { images, selectedIndex } = this.data;
		if (selectedIndex < 0 || selectedIndex >= images.length - 1) return;
		const arr = images.slice();
		[arr[selectedIndex + 1], arr[selectedIndex]] = [arr[selectedIndex], arr[selectedIndex + 1]];
		const laid = this._layoutImages(arr);
		this.setData({ images: laid, selectedIndex: selectedIndex + 1, stitchedTempPath: '', stitchProgress: 0 });
	},

	onClearImages() {
		this._releaseImages(this.data.images || []);
		const laid = this._layoutImages([]);
		this.setData({ images: laid, stitchedTempPath: '', selectedIndex: -1, stitchProgress: 0 });
	},
});


