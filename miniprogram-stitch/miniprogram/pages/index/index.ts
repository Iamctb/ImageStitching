/// <reference types="miniprogram-api-typings" />
import { createHighResCanvas, loadImageFrom, calcPreviewHeight, drawWithOrientation, safeCanvasToTempFilePath } from '../../utils/canvas';
import type { Direction, ChosenImage } from '../../utils/types';

Page({
	data: {
		images: [] as ChosenImage[],
		direction: 'vertical' as Direction,
		gap: 8,
		stitchedTempPath: '',
		canvasPreviewHeight: 240,
		selectedIndex: -1,
	},

	onLoad() {
		const info = wx.getSystemInfoSync();
		this.setData({ canvasPreviewHeight: calcPreviewHeight(info.windowWidth, 3/4) });
	},

	async onChooseImages() {
		try {
			const res = await wx.chooseMedia({
				count: 12,
				mediaType: ['image'],
				sizeType: ['original'],
				sourceType: ['album']
			});
			const detail: ChosenImage[] = [];
			for (const f of res.tempFiles) {
				const info = await wx.getImageInfo({ src: f.tempFilePath });
				detail.push({
					tempFilePath: f.tempFilePath,
					width: info.width,
					height: info.height,
					type: (info as any).type,
					orientation: (info as any).orientation
				});
			}
			this.setData({ images: detail, stitchedTempPath: '' });
		} catch (e) {
			wx.showToast({ title: '选择失败', icon: 'none' });
		}
	},

		onToggleDirection(e: WechatMiniprogram.SwitchChange) {
		this.setData({ direction: e.detail.value ? 'vertical' : 'horizontal', stitchedTempPath: '' });
	},

	onGapChange(e: WechatMiniprogram.SliderChange) {
		this.setData({ gap: e.detail.value || 0, stitchedTempPath: '' });
	},

	async onStitch() {
		const { images, direction, gap } = this.data as any;
		if (!images.length) return;
		const query = wx.createSelectorQuery();
		query.select('#preview').fields({ node: true, size: true }).exec(async (res) => {
			const node = res[0].node as WechatMiniprogram.Canvas;
			const size = res[0] as any;
			const { ctx } = createHighResCanvas(node, size.width, size.height);

			try {
				const gapPx = gap;
				let outW = 0, outH = 0;
				if (direction === 'vertical') {
					outW = Math.min(...images.map((i: ChosenImage) => i.width)); // 不放大
					outH = images.reduce((sum: number, i: ChosenImage, idx: number) => sum + Math.round(i.height * (outW / i.width)) + (idx ? gapPx : 0), 0);
				} else {
					outH = Math.min(...images.map((i: ChosenImage) => i.height)); // 不放大
					outW = images.reduce((sum: number, i: ChosenImage, idx: number) => sum + Math.round(i.width * (outH / i.height)) + (idx ? gapPx : 0), 0);
				}

				const off = (node as any).createOffscreenCanvas({ type: '2d', width: outW, height: outH });
				const octx = off.getContext('2d');
				octx.fillStyle = '#ffffff';
				octx.fillRect(0, 0, outW, outH);

				let cursorX = 0, cursorY = 0;
				for (let idx = 0; idx < images.length; idx++) {
					const img = images[idx];
					let bmp: any;
					try {
						bmp = await loadImageFrom(off, img.tempFilePath);
					} catch (err) {
						try {
							const conv = await wx.compressImage({ src: img.tempFilePath, quality: 100 });
							const convPath = (conv as any).tempFilePath || (conv as any).tempFilePath;
							bmp = await loadImageFrom(off, convPath);
						} catch (e) {
							bmp = await loadImageFrom(node, img.tempFilePath);
						}
					}

					if (direction === 'vertical') {
						const drawH = Math.round(img.height * (outW / img.width));
						drawWithOrientation(octx, bmp, 0, 0, bmp.width, bmp.height, 0, cursorY, outW, drawH, img.orientation as any);
						cursorY += drawH + gapPx;
					} else {
						const drawW = Math.round(img.width * (outH / img.height));
						drawWithOrientation(octx, bmp, 0, 0, bmp.width, bmp.height, cursorX, 0, drawW, outH, img.orientation as any);
						cursorX += drawW + gapPx;
					}
				}

				const tempPath = await safeCanvasToTempFilePath(off as any, 'png');

				const previewBmp = await loadImageFrom(node, (tempPath as any).tempFilePath);
				ctx.clearRect(0, 0, size.width, size.height);
				const scale = Math.min(size.width / outW, size.height / outH);
				const pvW = Math.round(outW * scale);
				const pvH = Math.round(outH * scale);
				ctx.drawImage(previewBmp as any, 0, 0, outW, outH, (size.width - pvW)/2, (size.height - pvH)/2, pvW, pvH);

				(this as any).setData({ stitchedTempPath: (tempPath as any).tempFilePath });
			} catch (err) {
				wx.showToast({ title: '拼图失败', icon: 'none' });
			}
		});
	},

	onSelectImage(e: any) {
		const idx = e.currentTarget.dataset.index as number;
		this.setData({ selectedIndex: idx });
	},

	onMoveLeft() {
		const { images, selectedIndex } = this.data as any;
		if (selectedIndex <= 0) return;
		const arr = images.slice();
		[arr[selectedIndex - 1], arr[selectedIndex]] = [arr[selectedIndex], arr[selectedIndex - 1]];
		this.setData({ images: arr, selectedIndex: selectedIndex - 1, stitchedTempPath: '' });
	},

	onMoveRight() {
		const { images, selectedIndex } = this.data as any;
		if (selectedIndex < 0 || selectedIndex >= images.length - 1) return;
		const arr = images.slice();
		[arr[selectedIndex + 1], arr[selectedIndex]] = [arr[selectedIndex], arr[selectedIndex + 1]];
		this.setData({ images: arr, selectedIndex: selectedIndex + 1, stitchedTempPath: '' });
	},

	onClearImages() {
		this.setData({ images: [], stitchedTempPath: '', selectedIndex: -1 });
	},

	async onSave() {
		const { stitchedTempPath } = this.data as any;
		if (!stitchedTempPath) return;
		try {
			await wx.saveImageToPhotosAlbum({ filePath: stitchedTempPath });
			wx.showToast({ title: '已保存到相册', icon: 'success' });
		} catch (e) {
			if ((e as any).errMsg?.includes('auth')) {
				wx.openSetting({});
			} else {
				wx.showToast({ title: '保存失败', icon: 'none' });
			}
		}
	}
});


