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

export async function safeCanvasToTempFilePath(canvas: any, prefer: 'png' | 'jpg' = 'png') {
	try {
		return await wx.canvasToTempFilePath({ canvas, fileType: prefer, quality: 1 });
	} catch (e) {
		try {
			// @ts-ignore
			return await new Promise<any>((resolve, reject) => canvas.toTempFilePath({ fileType: prefer, quality: 1, success: resolve, fail: reject }));
		} catch (err) {
			throw err;
		}
	}
}

