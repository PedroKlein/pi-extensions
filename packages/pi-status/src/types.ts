/** Segment render function type */
export type SegmentRenderer = (theme: any) => string;

/** Registered segment */
export interface Segment {
	id: string;
	priority: number;
	render: SegmentRenderer;
}

/** Event payload for pi-status:register */
export interface RegisterPayload {
	id: string;
	priority?: number;
	render: SegmentRenderer;
}

/** Event payload for pi-status:update */
export interface UpdatePayload {
	id: string;
	render: SegmentRenderer | null;
}
