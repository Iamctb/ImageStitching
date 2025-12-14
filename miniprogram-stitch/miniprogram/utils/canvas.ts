export function createHighResCanvas(canvas: WechatMiniprogram.Canvas, width: number, height: number) {
	const dpr = wx.getSystemInfoSync().pixelRatio || 1;
	canvas.width = Math.floor(width * dpr);
	canvas.height = Math.floor(height * dpr);
	const ctx = canvas.getContext('2d') as WechatMiniprogram.RenderingContext;
	ctx.scale(dpr, dpr);
	return { ctx, dpr };
}

export async function loadImageFrom(
	node: any,
	src: string,
	options?: { timeout?: number; allowGlobalFallback?: boolean; preferGlobal?: boolean }
): Promise<any> {
	const opts = options || {};
	const timeout = typeof opts.timeout === 'number' ? opts.timeout : 4000;
	const allowGlobal = opts.allowGlobalFallback !== false;
	const preferGlobal = !!opts.preferGlobal;
	const hasGlobal = allowGlobal && typeof wx.createImage === 'function';
	const hasNode = node && typeof node.createImage === 'function';
	const creators: Array<() => any> = [];

	const appendCreator = (type: 'global' | 'node') => {
		if (type === 'global' && hasGlobal) {
			creators.push(() => wx.createImage());
		} else if (type === 'node' && hasNode) {
			creators.push(() => node.createImage());
		}
	};

	if (preferGlobal) {
		appendCreator('global');
		appendCreator('node');
	} else {
		appendCreator('node');
		appendCreator('global');
	}

	if (!creators.length) {
		throw new Error('no image creator available');
	}

	const tryLoad = (creator: () => any) => new Promise<any>((resolve, reject) => {
		let img: any;
		try {
			img = creator();
		} catch (err) {
			reject(err);
			return;
		}

		let finished = false;
		let timer: any = null;

		if (timeout > 0) {
			timer = setTimeout(() => {
				if (finished) return;
				finished = true;
				if (img) {
					try {
						img.onload = null;
						img.onerror = null;
						img.src = '';
					} catch (e) {}
				}
				reject(new Error('load timeout'));
			}, timeout);
		}

		img.onload = () => {
			if (finished) return;
			finished = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			img.onload = null;
			img.onerror = null;
			resolve(img);
		};
		img.onerror = (err: any) => {
			if (finished) return;
			finished = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (img) {
				try {
					img.onload = null;
					img.onerror = null;
					img.src = '';
				} catch (e) {}
			}
			reject(err || new Error('load error'));
		};
		img.src = src;
	});

	const runSequential = async (index: number, lastErr: any): Promise<any> => {
		if (index >= creators.length) {
			throw lastErr || new Error('load failed');
		}
		try {
			return await tryLoad(creators[index]);
		} catch (err) {
			return await runSequential(index + 1, err);
		}
	};

	return await runSequential(0, null);
}

export function calcPreviewHeight(screenWidth: number, aspect: number) {
	const padding = 32;
	const innerWidth = screenWidth - padding * 2;
	return Math.max(180, innerWidth / aspect);
}

export function drawWithOrientation(ctx: any, img: any, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, orientation?: number) {
	ctx.save();
	if (!orientation || orientation === 1) {
		ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
		ctx.restore();
		return;
	}
	switch (orientation) {
		case 2:
			ctx.translate(dx + dw, dy);
			ctx.scale(-1, 1);
			ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
			break;
		case 3:
			ctx.translate(dx + dw, dy + dh);
			ctx.rotate(Math.PI);
			ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
			break;
		case 4:
			ctx.translate(dx, dy + dh);
			ctx.scale(1, -1);
			ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
			break;
		case 5:
			ctx.translate(dx, dy);
			ctx.rotate(0.5 * Math.PI);
			ctx.scale(1, -1);
			ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dh, dw);
			break;
		case 6:
			ctx.translate(dx + dw, dy);
			ctx.rotate(0.5 * Math.PI);
			ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dh, dw);
			break;
		case 7:
			ctx.translate(dx + dw, dy);
			ctx.rotate(0.5 * Math.PI);
			ctx.scale(-1, 1);
			ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dh, dw);
			break;
		case 8:
			ctx.translate(dx, dy + dh);
			ctx.rotate(-0.5 * Math.PI);
			ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dh, dw);
			break;
		default:
			ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
	}
	ctx.restore();
}

export async function safeCanvasToTempFilePath(
	canvas: any,
	prefer: 'png' | 'jpg' = 'png',
	width?: number,
	height?: number,
	destWidth?: number,
	destHeight?: number
) {
	const w = Math.max(1, Math.floor(width || canvas.width || 0));
	const h = Math.max(1, Math.floor(height || canvas.height || 0));
	const dw = Math.max(1, Math.floor(destWidth || w));
	const dh = Math.max(1, Math.floor(destHeight || h));
	try {
		return await wx.canvasToTempFilePath({
			canvas,
			x: 0,
			y: 0,
			width: w,
			height: h,
			destWidth: dw,
			destHeight: dh,
			fileType: prefer,
			quality: 1,
		});
	} catch (e) {
		try {
			// @ts-ignore
			return await new Promise<any>((resolve, reject) =>
				canvas.toTempFilePath({
					x: 0,
					y: 0,
					width: w,
					height: h,
					destWidth: dw,
					destHeight: dh,
					fileType: prefer,
					quality: 1,
					success: resolve,
					fail: reject,
				})
			);
		} catch (err) {
			throw err;
		}
	}
}

function inferExtLower(path: string) {
	try {
		const pure = String(path || '').split('?')[0];
		const m = pure.match(/\.([a-zA-Z0-9]+)$/);
		return m ? String(m[1]).toLowerCase() : '';
	} catch (e) {
		return '';
	}
}

// 兜底：仅在必要时转码（避免对 jpg/png 等已兼容图片重复压缩导致清晰度下降）
export async function tryTranscodeIfNeeded(path: string) {
	const ext = inferExtLower(path);
	const looksHeic = ext === 'heic' || ext === 'heif';
	const looksSupported =
		ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp' || ext === 'bmp' || ext === 'gif';
	if (looksSupported && !looksHeic) return path;
	try {
		// @ts-ignore
		const res = await wx.compressImage({ src: path, quality: 100 });
		return res.tempFilePath || path;
	} catch (e) {
		return path;
	}
}

