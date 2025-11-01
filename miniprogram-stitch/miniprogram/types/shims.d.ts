// Minimal shims for wx and WechatMiniprogram to satisfy TS in local editing
declare const wx: any;
declare namespace WechatMiniprogram {
	interface Canvas {
		width: number;
		height: number;
		getContext(type: '2d'): RenderingContext;
		createImage(): any;
	}
	interface RenderingContext {
		scale(x: number, y: number): void;
		drawImage(...args: any[]): void;
		save(): void;
		restore(): void;
		translate(x: number, y: number): void;
		rotate(rad: number): void;
		scale(x: number, y: number): void;
		clearRect(x: number, y: number, w: number, h: number): void;
		fillStyle: string;
		fillRect(x: number, y: number, w: number, h: number): void;
	}
}

