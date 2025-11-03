// 引入工具方法：高分 canvas、图片加载、朝向绘制、导出、转码兜底、离屏画布创建
const { createHighResCanvas, loadImageFrom, calcPreviewHeight, drawWithOrientation, safeCanvasToTempFilePath, tryTranscodeIfNeeded, safeCreateOffscreenCanvas } = require('../../utils/canvas.js');

Page({
	data: {
		images: [],
		direction: 'vertical',
		gap: 8,
		stitchedTempPath: '',
		canvasPreviewHeight: 240,
		selectedIndex: -1,
	},

	// 可选最大图片数（可按需调整）
	MAX_IMAGES: 12,

	onLoad() {
		const info = wx.getSystemInfoSync();
		this.setData({ canvasPreviewHeight: calcPreviewHeight(info.windowWidth, 3/4) });
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
				} catch (e1) { console.warn('chooseMessageFile失败', e1); }
			}
			// 2) 常规环境使用 chooseImage
			if (!files.length) {
				try {
					const r = await this._pChooseImage({ count: remain, sizeType: ['original','compressed'], sourceType: ['album','camera'] });
					if (r.tempFiles && r.tempFiles.length) {
						files = r.tempFiles.map(f => ({ tempFilePath: f.tempFilePath || f.path }));
					} else {
						files = (r.tempFilePaths || []).map(p => ({ tempFilePath: p }));
					}
				} catch (e2) { console.warn('chooseImage失败', e2); }
			}
			// 3) 兜底使用 chooseMedia
			if (!files.length) {
				try {
					const r = await this._pChooseMedia({ count: remain, mediaType: ['image'], sizeType: ['original','compressed'], sourceType: ['album','camera'] });
					files = (r.tempFiles || []).map(f => ({ tempFilePath: f.tempFilePath, width: f.width, height: f.height }));
				} catch (e3) { console.warn('chooseMedia失败', e3); }
			}

			if (!files.length) throw new Error('未获取到文件');
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
        this.setData({ images: dedup, stitchedTempPath: '' });
    } catch (e) {
			const msg = (e && e.errMsg || '').includes('cancel') ? '已取消' : '选择失败';
			wx.showToast({ title: msg, icon: 'none' });
    }
},

	onToggleDirection(e) {
		this.setData({ direction: e.detail.value ? 'vertical' : 'horizontal', stitchedTempPath: '' });
	},

	onGapChange(e) {
		this.setData({ gap: e.detail.value || 0, stitchedTempPath: '' });
	},

onGapChanging(e) {
    this.setData({ gap: e.detail.value || 0, stitchedTempPath: '' });
},

	onStitch: async function() {
    const { images, direction, gap } = this.data;
		if (!images.length) return;
		const query = wx.createSelectorQuery();
		query.select('#preview').fields({ node: true, size: true }).exec(async (res) => {
			const node = res[0].node;
			const size = res[0];
			const { ctx } = createHighResCanvas(node, size.width, size.height);

			try {
				// 1) 预探测：若有图片缺少宽高，使用主画布节点加载一次获取天然尺寸（真机更稳定）
				for (const it of images) {
					if (!it.width || !it.height) {
						try {
							const el = await loadImageFrom(node, it.tempFilePath);
							it.width = el.width; it.height = el.height;
						} catch (pe) { /* 忽略，后续绘制仍会再尝试 */ }
					}
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

                // 3) 离屏画布安全创建
                const off = safeCreateOffscreenCanvas(node, outW, outH);
				const octx = off.getContext('2d');
				octx.fillStyle = '#ffffff';
				octx.fillRect(0, 0, outW, outH);

				let cursorX = 0, cursorY = 0;
				for (let idx = 0; idx < images.length; idx++) {
					const img = images[idx];
					let bmp;
                    try {
                        bmp = await loadImageFrom(off, img.tempFilePath);
                    } catch (err) {
                        // 解码失败兜底：先转码再加载；仍失败则从主画布加载
                        const convPath = await tryTranscodeIfNeeded(img.tempFilePath);
                        try {
                            bmp = await loadImageFrom(off, convPath);
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
				}

                // 4) 显式指定导出区域，避免出现仅导出第一张裁剪内容的问题
                const tempPath = await safeCanvasToTempFilePath(off, 'png', outW, outH);

				const previewBmp = await loadImageFrom(node, tempPath.tempFilePath);
				ctx.clearRect(0, 0, size.width, size.height);
				const scale = Math.min(size.width / outW, size.height / outH);
				const pvW = Math.round(outW * scale);
				const pvH = Math.round(outH * scale);
				ctx.drawImage(previewBmp, 0, 0, outW, outH, (size.width - pvW)/2, (size.height - pvH)/2, pvW, pvH);

                this.setData({ stitchedTempPath: tempPath.tempFilePath });
			} catch (err) {
                console.error('拼图失败', err);
                const msg = err && (err.errMsg || err.message) ? ('拼图失败：' + (err.errMsg || err.message)) : '拼图失败';
                wx.showToast({ title: msg, icon: 'none' });
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

	onSelectImage(e) {
		const idx = e.currentTarget.dataset.index;
		this.setData({ selectedIndex: idx });
	},

	onMoveLeft() {
		const { images, selectedIndex } = this.data;
		if (selectedIndex <= 0) return;
		const arr = images.slice();
		[arr[selectedIndex - 1], arr[selectedIndex]] = [arr[selectedIndex], arr[selectedIndex - 1]];
		this.setData({ images: arr, selectedIndex: selectedIndex - 1, stitchedTempPath: '' });
	},

	onMoveRight() {
		const { images, selectedIndex } = this.data;
		if (selectedIndex < 0 || selectedIndex >= images.length - 1) return;
		const arr = images.slice();
		[arr[selectedIndex + 1], arr[selectedIndex]] = [arr[selectedIndex], arr[selectedIndex + 1]];
		this.setData({ images: arr, selectedIndex: selectedIndex + 1, stitchedTempPath: '' });
	},

	onClearImages() {
		this.setData({ images: [], stitchedTempPath: '', selectedIndex: -1 });
	},
});


