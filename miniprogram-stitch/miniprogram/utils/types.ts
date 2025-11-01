export type Direction = vertical | horizontal;

export interface ChosenImage {
	tempFilePath: string;
	width: number;
	height: number;
	type?: string;
	orientation?: any;
}
