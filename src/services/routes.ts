type ApiRoute = {
	id: string;
	agency: string;
	shortName: string;
	longName: string;
	type: string;
	color: string;
	textColor: string;
	shape: {
		type: string;
		points: Array<{ lat: number; lng: number }>;
	};
};
