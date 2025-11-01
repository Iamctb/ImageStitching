export function createHighResCanvas(canvas: WechatMiniprogram.Canvas, width: number, height: number) {
	const dpr = wx.getSystemInfoSync().pixelRatio || 1;
	canvas.width = Math.floor(width * dpr);
	canvas.height = Math.floor(height * dpr);
	const ctx = canvas.getContext('2d') as WechatMiniprogram.RenderingContext;
	ctx.scale(dpr, dpr);
	return { ctx, dpr };
}

export async function loadImageFrom(node: any, src: string): Promise<any> {
	return await new Promise((resolve, reject) => {
		try {
			const img = node.createImage();
			img.onload = () => resolve(img);
			img.onerror = (err: any) => reject(err);
			img.src = src;
		} catch (e) {
			reject(e);
		}
	});
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

