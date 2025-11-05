// 引入工具方法：高分 canvas、图片加载、朝向绘制、导出、转码兜底、离屏画布创建
const { createHighResCanvas, loadImageFrom, calcPreviewHeight, drawWithOrientation, safeCanvasToTempFilePath, tryTranscodeIfNeeded, safeCreateOffscreenCanvas } = require('../../utils/canvas.js');

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
		showTips: true,
		_lastTipsTap: 0,
		_lastBlankTap: 0,
	},

	// 空操作：用于遮罩拦截点击
	noop() {},

	// 拖拽开始
	onDragStart(e) {
		const idx = e.currentTarget.dataset.index;
		const imgs = this.data.images.slice();
		// 提高被拖拽项层级：将其放到数组末尾渲染层级更高（不改变逻辑位置）
		// 这里不重排，只记录索引
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
		this._updateThumbsHeightByLength(moved.length);
		this.setData({ images: moved, dragging: false, dragIndex: -1, dragShadowIndex: -1, stitchedTempPath: '' });
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
		arr.splice(idx, 1);
		const laid = this._layoutImages(arr);
		this.setData({ images: laid, selectedIndex: -1, showDeleteModal: false, modalImage: '', modalIndex: -1, stitchedTempPath: '', stitchProgress: 0 });
	},

	onCancelDelete() {
		this.setData({ showDeleteModal: false, modalImage: '', modalIndex: -1 });
	},

	// 可选最大图片数（可按需调整）
	MAX_IMAGES: 12,

	onLoad() {
		const info = wx.getSystemInfoSync();
		const pxPerRpx = info.windowWidth / 750;
		const thumbWpx = Math.round(pxPerRpx * 160);
		const thumbGapPx = Math.round(pxPerRpx * 12);
		// 预留左右内边距约 32rpx
		const innerWidth = info.windowWidth - Math.round(pxPerRpx * 32);
		const columns = Math.max(1, Math.floor(innerWidth / (thumbWpx + thumbGapPx)));
		this.setData({
			canvasPreviewHeight: calcPreviewHeight(info.windowWidth, 3/4),
			thumbWpx,
			thumbGapPx,
			columns,
			thumbsHeight: thumbWpx + thumbGapPx,
		});
		// 初始化布局，确保显示“上传图片”卡片
		const laid = this._layoutImages(this.data.images || []);
		this.setData({ images: laid });
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
		// 计算包含“上传图片”占位卡片后的行数（仅当可继续添加时才预留一格）
		const rows = Math.max(1, Math.ceil((laid.length + (canAdd ? 1 : 0)) / columns));
		const thumbsHeight = rows * (thumbWpx + thumbGapPx);
		// 计算上传卡片位置：紧随其后
		const nextIdx = laid.length;
		const ncol = nextIdx % columns;
		const nrow = Math.floor(nextIdx / columns);
		const addX = ncol * (thumbWpx + thumbGapPx);
		const addY = nrow * (thumbWpx + thumbGapPx);
		this.setData({ thumbsHeight, addX, addY, canAdd });
		return laid;
	},

	_moveItem(arr, from, to) {
		if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
		const copy = arr.slice();
		const [it] = copy.splice(from, 1);
		copy.splice(to, 0, it);
		return copy;
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
		this.setData({ showGapModal: true, gapModalTitle: '竖向拼接设置', gapTemp: Math.min(20, Math.max(0, this.data.gap || 0)) });
	},
	onLongPressHorizontal() {
		this.setData({ showGapModal: true, gapModalTitle: '横向拼接设置', gapTemp: Math.min(20, Math.max(0, this.data.gap || 0)) });
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
		this.setData({ gap: v, showGapModal: false, stitchedTempPath: '', stitchProgress: 0 });
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
		this.setData({ showGapInput: true, gapInputFocus: true });
	},
	onGapInputBlur(e) {
		let v = Number(e.detail.value);
		if (Number.isNaN(v)) v = this.data.gapTemp || 0;
		v = Math.min(20, Math.max(0, Math.round(v)));
		this.setData({ gapTemp: v, showGapInput: false, gapInputFocus: false });
	},
	onGapInputConfirm(e) {
		this.onGapInputBlur(e);
	},

	// 双击温馨提示隐藏/显示
	onTipsTap() {
		const now = Date.now();
		const last = this.data._lastTipsTap || 0;
		if (now - last < 500) {
			this.setData({ showTips: !this.data.showTips, _lastTipsTap: 0 });
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
					const r = await this._pChooseImage({ count: remain, sizeType: ['original','compressed'], sourceType: ['album','camera'] });
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
					const r = await this._pChooseMedia({ count: remain, mediaType: ['image'], sizeType: ['original','compressed'], sourceType: ['album','camera'] });
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
		const laid = this._layoutImages(dedup);
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
    const { images, direction, gap } = this.data;
		if (!images.length) return;
		// 开始前复位状态
		this.setData({ isStitching: true, stitchProgress: 1, stitchedTempPath: '' });
		const query = wx.createSelectorQuery();
		query.select('#preview').fields({ node: true, size: true }).exec(async (res) => {
			const node = res[0].node;
			const size = res[0];
			const { ctx } = createHighResCanvas(node, size.width, size.height);

			try {
				// 1) 预探测：若有图片缺少宽高，使用主画布节点加载一次获取天然尺寸（真机更稳定）
				let doneProbe = 0;
				for (const it of images) {
					if (!it.width || !it.height) {
						try {
							const el = await loadImageFrom(node, it.tempFilePath);
							it.width = el.width; it.height = el.height;
						} catch (pe) { /* 忽略，后续绘制仍会再尝试 */ }
					}
					doneProbe++;
					// 预探测阶段进度：1% -> 25%
					const p = Math.min(25, Math.round(1 + (doneProbe / images.length) * 24));
					this.setData({ stitchProgress: p });
				}

                // 2) 计算输出尺寸，严格避免放大；若仍有无效尺寸则提前提示
                const allW = images.map(i => i.width || 0).filter(n => n > 0);
                const allH = images.map(i => i.height || 0).filter(n => n > 0);
                if (!allW.length || !allH.length) throw new Error('图片尺寸不可用');
				const gapPx = gap;
				let outW = 0, outH = 0;
                if (direction === 'vertical') {
                    outW = Math.min.apply(null, allW);
                    outH = images.reduce((sum, i, idx) => sum + Math.round((i.height || 0) * (outW / (i.width || outW))) + (idx ? gapPx : 0), 0);
                } else {
                    outH = Math.min.apply(null, allH);
                    outW = images.reduce((sum, i, idx) => sum + Math.round((i.width || 0) * (outH / (i.height || outH))) + (idx ? gapPx : 0), 0);
                }
				if (!outW || !outH) throw new Error('输出尺寸计算失败');

				// 限制画布最大尺寸（微信/设备上限通常为 16384）
				const MAX_CANVAS_SIDE = 16384;
				if (outW > MAX_CANVAS_SIDE || outH > MAX_CANVAS_SIDE) {
					const scale = Math.min(MAX_CANVAS_SIDE / outW, MAX_CANVAS_SIDE / outH);
					outW = Math.max(1, Math.floor(outW * scale));
					outH = Math.max(1, Math.floor(outH * scale));
				}
				this.setData({ stitchProgress: 30 });

				// 3) 离屏画布安全创建；若不可用则退回使用主画布进行合成
				let off, octx, usedMain = false;
				try {
					off = safeCreateOffscreenCanvas(node, outW, outH);
					octx = off.getContext('2d');
				} catch (eOff) {
					console.warn('Offscreen 不可用，回退主画布', eOff);
					usedMain = true;
					const backupW = node.width, backupH = node.height;
					// 将主画布分辨率设为输出尺寸
					node.width = outW; node.height = outH;
					octx = node.getContext('2d');
					if (octx && octx.setTransform) octx.setTransform(1, 0, 0, 1, 0, 0);
					// 在 finally 中恢复预览
					var __restoreMainCanvas = () => {
						try {
							// 恢复预览画布分辨率与上下文缩放
							createHighResCanvas(node, size.width, size.height);
						} catch(_) {}
					};
				}
				octx.fillStyle = '#ffffff';
				octx.fillRect(0, 0, outW, outH);

				let cursorX = 0, cursorY = 0;
				for (let idx = 0; idx < images.length; idx++) {
					const img = images[idx];
					let bmp;
                    try {
                        bmp = await loadImageFrom(usedMain ? node : off, img.tempFilePath);
                    } catch (err) {
                        // 解码失败兜底：先转码再加载；仍失败则从主画布加载
                        const convPath = await tryTranscodeIfNeeded(img.tempFilePath);
                        try {
                            bmp = await loadImageFrom(usedMain ? node : off, convPath);
                        } catch (e) {
                            bmp = await loadImageFrom(node, convPath);
                        }
                    }

					if (direction === 'vertical') {
						const drawH = Math.round(img.height * (outW / img.width));
						drawWithOrientation(octx, bmp, 0, 0, bmp.width, bmp.height, 0, cursorY, outW, drawH, img.orientation);
						cursorY += drawH + gapPx;
					} else {
						const drawW = Math.round(img.width * (outH / img.height));
						drawWithOrientation(octx, bmp, 0, 0, bmp.width, bmp.height, cursorX, 0, drawW, outH, img.orientation);
						cursorX += drawW + gapPx;
					}

					// 绘制阶段进度：30% -> 90%
					const p2 = 30 + Math.round(((idx + 1) / images.length) * 60);
					this.setData({ stitchProgress: Math.min(90, p2) });
				}

                // 4) 显式指定导出区域，避免出现仅导出第一张裁剪内容的问题
				const tempPath = await safeCanvasToTempFilePath(usedMain ? node : off, 'png', outW, outH);
				this.setData({ stitchProgress: 96 });

				const previewBmp = await loadImageFrom(node, tempPath.tempFilePath);
				ctx.clearRect(0, 0, size.width, size.height);
				const scale = Math.min(size.width / outW, size.height / outH);
				const pvW = Math.round(outW * scale);
				const pvH = Math.round(outH * scale);
				ctx.drawImage(previewBmp, 0, 0, outW, outH, (size.width - pvW)/2, (size.height - pvH)/2, pvW, pvH);

				this.setData({ stitchedTempPath: tempPath.tempFilePath, stitchProgress: 100, isStitching: false });
				// 拼接完成后直接预览整图
				wx.previewImage({ current: tempPath.tempFilePath, urls: [tempPath.tempFilePath] });
			} catch (err) {
                console.error('拼图失败', err);
                const msg = err && (err.errMsg || err.message) ? ('拼图失败：' + (err.errMsg || err.message)) : '拼图失败';
				wx.showToast({ title: msg, icon: 'none' });
				this.setData({ isStitching: false, stitchProgress: 0 });
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
		const urls = (this.data.images || []).map(it => it.tempFilePath);
		if (!urls.length) return;
		wx.previewImage({ current: urls[idx], urls });
		this.setData({ selectedIndex: idx });
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
		const laid = this._layoutImages([]);
		this.setData({ images: laid, stitchedTempPath: '', selectedIndex: -1, stitchProgress: 0 });
	},
});


