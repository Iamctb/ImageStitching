// 安全获取设备像素比：优先使用新 API，其次回退旧 API
function getDevicePixelRatio() {
    try {
        if (wx.getWindowInfo) {
            const info = wx.getWindowInfo();
            return info.pixelRatio || 1;
        }
    } catch (e) {}
    try {
        const info = wx.getSystemInfoSync();
        return info.pixelRatio || 1;
    } catch (e) {}
    return 1;
}

// 创建高分屏 Canvas，保证预览清晰
function createHighResCanvas(canvas, width, height) {
    const dpr = getDevicePixelRatio();
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, dpr };
}

// 从某个 canvas 节点（主画布或离屏画布）创建图片对象并加载
function loadImageFrom(node, src, options) {
    const opts = options || {};
    const timeout = typeof opts.timeout === 'number' ? opts.timeout : 4000;
    const allowGlobal = opts.allowGlobalFallback !== false;
    const preferGlobal = !!opts.preferGlobal;
    const hasGlobal = allowGlobal && typeof wx.createImage === 'function';
    const hasNode = node && typeof node.createImage === 'function';
    const creators = [];

    const appendCreator = (type) => {
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
        return Promise.reject(new Error('no image creator available'));
    }

    const tryLoad = (creator) => new Promise((resolve, reject) => {
        let img;
        try {
            img = creator();
        } catch (err) {
            reject(err);
            return;
        }

        let finished = false;
        let timer = null;

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
        img.onerror = (err) => {
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

    const runSequential = (index, lastErr) => {
        if (index >= creators.length) {
            throw lastErr || new Error('load failed');
        }
        return tryLoad(creators[index]).catch((err) => runSequential(index + 1, err));
    };

    return runSequential(0, null);
}

// 计算预览区域高度，依据期望宽高比自适应
function calcPreviewHeight(screenWidth, aspect) {
    const padding = 32;
    const innerWidth = screenWidth - padding * 2;
    return Math.max(180, innerWidth / aspect);
}

// 安全创建离屏画布：兼容不同基础库的签名差异
function safeCreateOffscreenCanvas(node, width, height) {
    // 方式一：使用节点自身的 offscreen 能力
    try {
        const off1 = node.createOffscreenCanvas({ type: '2d', width, height });
        if (off1 && off1.getContext) return off1;
    } catch (e) {}
    try {
        const off2 = node.createOffscreenCanvas();
        if (off2 && off2.getContext) { off2.width = width; off2.height = height; return off2; }
    } catch (e2) {}
    // 方式二：使用全局 wx.createOffscreenCanvas（更通用）
    try {
        if (wx.createOffscreenCanvas) {
            const off3 = wx.createOffscreenCanvas({ type: '2d', width, height });
            if (off3 && off3.getContext) return off3;
        }
    } catch (e3) {}
    // 不再回退到主画布，避免与预览 DPR 缩放冲突导致导出裁剪
    throw new Error('OffscreenCanvas 不可用');
}

// 根据 EXIF 朝向绘制图像，保证方向正确
function drawWithOrientation(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh, orientation) {
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

// 将 Canvas 导出为临时文件，兼容新旧 API，并显式指定导出区域避免裁剪
async function safeCanvasToTempFilePath(canvas, prefer = 'png', width, height) {
    const w = Math.max(1, Math.floor(width || canvas.width || 0));
    const h = Math.max(1, Math.floor(height || canvas.height || 0));
    try {
        return await wx.canvasToTempFilePath({
            canvas,
            x: 0,
            y: 0,
            width: w,
            height: h,
            destWidth: w,
            destHeight: h,
            fileType: prefer,
            quality: 1,
        });
    } catch (e) {
        return await new Promise((resolve, reject) => {
            if (canvas && canvas.toTempFilePath) {
                canvas.toTempFilePath({
                    x: 0,
                    y: 0,
                    width: w,
                    height: h,
                    destWidth: w,
                    destHeight: h,
                    fileType: prefer,
                    quality: 1,
                    success: resolve,
                    fail: reject,
                });
            } else {
                reject(e);
            }
        });
    }
}

// 兜底：尝试通过压缩生成可解码的中间文件（处理 HEIC 等不兼容情况）
async function tryTranscodeIfNeeded(path) {
    try {
        const res = await wx.compressImage({ src: path, quality: 100 });
        return res.tempFilePath || path;
    } catch (e) {
        return path;
    }
}

module.exports = {
	createHighResCanvas,
	loadImageFrom,
	calcPreviewHeight,
	drawWithOrientation,
	safeCanvasToTempFilePath,
    tryTranscodeIfNeeded,
    safeCreateOffscreenCanvas,
};


