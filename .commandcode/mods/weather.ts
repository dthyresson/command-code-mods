// Mod: weather — shows current weather & temperature in footer status
// Uses Open-Meteo (no API key). Units passed via API params, rendered with no conversions.
// Flags: --mod-option city=Boston,MA --mod-option temp_unit=fahrenheit|celsius
//        --mod-option wind_speed_unit=mph|kmh
// Command: /weather [city] [f|m] — city + short unit shortcut (/weather Paris f)

import type {ModApi} from '@commandcode/harness';

export default function (cmd: ModApi): void {
	const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
	const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
	const CACHE_LIFE_MS = 10 * 60 * 1000; // 10 min
	const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

	// ── WMO weather condition emojis ────────────────────────────────────────────

	const CONDITION_EMOJI: Record<number, string> = {
		0: '\u{1F324}\uFE0F',
		1: '\uD83C\uDF24\uFE0F',
		2: '\u26C5',
		3: '\u2601\uFE0F',
		45: '\uD83D\uDCA1',
		48: '\uD83D\uDCA1',
		51: '\uD83D\uDCA7',
		53: '\uD83D\uDCA7',
		55: '\uD83D\uDCA7',
		56: '\uD83E\uDDA8',
		57: '\uD83E\uDDA8',
		61: '\uD83D\uDCA8',
		63: '\uD83D\uDCA8',
		65: '\uD83D\uDCA8',
		66: '\uD83E\uDEB6',
		67: '\uD83E\uDEB6',
		71: '\u2744\uFE0F',
		73: '\u2744\uFE0F',
		75: '\u2744\uFE0F',
		77: '\uD83E\uDDCA',
		80: '\uD83D\uDCA8',
		81: '\uD83D\uDCA8',
		82: '\uD83D\uDCA8',
		85: '\u2744\uFE0F',
		86: '\u2744\uFE0F',
		95: '\u26C8\uFE0F',
		96: '\u26C8\uFE0F',
		99: '\u26C8\uFE0F',
	};

	type WeatherData = {temp: number; wind: number; code: number; temp_unit: string; wind_unit: string; place?: string};
	let cache: {coords: {lat: number; lon: number}; data: WeatherData | null; ts: number} | null = null;

	// ── helpers ─────────────────────────────────────────────────────────────────

	function apiToLabel(unit: string): string {
		switch (unit.toLowerCase()) {
			case 'fahrenheit': case 'f': return '\u00B0F';
			case 'celsius': case 'c': return '\u00B0C';
			case 'mph': return 'mph';
			case 'kmh': return 'km/h';
			case 'ms': return 'm/s';
			case 'kn': return 'kn';
			default: return '';
		}
	}

	async function geoQuery(q: string): Promise<{lat: number; lon: number} | null> {
		const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=1`;
		const res = await fetch(url);
		if (!res.ok) return null;
		const json = (await res.json()) as {results?: [{latitude: number; longitude: number}]};
		return json.results?.[0] ? {lat: json.results[0].latitude, lon: json.results[0].longitude} : null;
	}

	// ── weather fetch ───────────────────────────────────────────────────────────

	async function fetchWeather(city: string, tempUnit: string, windUnit: string): Promise<WeatherData | null> {
		const cached = cache;
		if (cached && Date.now() - cached.ts < CACHE_LIFE_MS && cached.data?.temp_unit === tempUnit && cached.data?.wind_unit === windUnit) return cached.data;
		try {
			const coords = await geoQuery(city);
			if (!coords) return null;
			const url = `${WEATHER_URL}?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m,windspeed_10m,weathercode&temperature_unit=${tempUnit}&wind_speed_unit=${windUnit}`;
			const res = await fetch(url);
			if (!res.ok) return null;
			const json = (await res.json()) as {current?: {temperature_2m?: number; relative_humidity_2m?: number; windspeed_10m?: number; weathercode?: number}};
			const cur = json.current;
			if (!cur || cur.temperature_2m == null) return null;
			const d: WeatherData = {
				temp: cur.temperature_2m,
				wind: cur.windspeed_10m ?? 0,
				code: cur.weathercode ?? 0,
				temp_unit: tempUnit,
				wind_unit: windUnit,
				place: city,
			};
			cache = {coords, data: d, ts: Date.now()};
			return d;
		} catch { return null; }
	}

	// ── render ──────────────────────────────────────────────────────────────────

	function render(w: WeatherData | null): string {
		if (!w) return `\u{1F321}\uFE0F Weather unavailable`;
		const emoji = Object.entries(CONDITION_EMOJI).find(([k]) => Number(k) === w.code)?.[1] ?? '';
		const label = w.place ? w.place.charAt(0).toUpperCase() + w.place.slice(1) : '?';
		const t = apiToLabel(w.temp_unit);
		const u = apiToLabel(w.wind_unit);
		return `${emoji} ${label} \u2014 ${Math.round(w.temp)}${t}, Wind ${Math.round(w.wind)} ${u}`;
	}

	// ── display ─────────────────────────────────────────────────────────────────

	let widgetDisp: {dispose: () => void} | undefined = cmd.ui.widget({placement: 'above-editor', render: () => [render(cache?.data ?? null)]});
	let intervalId: ReturnType<typeof setInterval>;

	function refresh(tempU: string, windU: string) {
		fetchWeather(cmd.getFlag('city') as string, tempU, windU).then(w => {
			const t = render(w);
			cmd.ui.setStatus(t || `\u{1F321}\uFE0F Error fetching weather`);
			widgetDisp?.dispose();
			widgetDisp = cmd.ui.widget({placement: 'above-editor', render: () => [t]});
			clearInterval(intervalId);
			intervalId = setInterval(() => { fetchWeather(cmd.getFlag('city') as string, tempU, windU).then(x => cmd.ui.setStatus(render(x))); }, REFRESH_INTERVAL_MS);
		});
	}

	// ── registration ────────────────────────────────────────────────────────────

	cmd.addFlag('city', {type: 'string', default: 'Boston, MA', description: 'City name for weather lookups.'});
	cmd.addFlag('temp_unit', {type: 'string', default: 'fahrenheit', description: 'Temperature unit: fahrenheit or celsius.'});
	cmd.addFlag('wind_speed_unit', {type: 'string', default: 'mph', description: 'Wind speed unit: mph or kmh.'});

	cmd.addCommand({
		name: 'weather',
		description: 'Refresh weather or set units (/weather Paris f)',
		handler: ({args}) => {
			const rest = args.trim().split(/\s+/);
			let oCity: string | undefined, oTemp: string | undefined, oWind: string | undefined;
			for (const a of rest) {
				if (a.startsWith('--')) { const v = a.slice(2); if (v.startsWith('temp=')) oTemp = v.split('=')[1]; else if (v.startsWith('wind=')) oWind = v.split('=')[1]; else if (v.startsWith('city=')) oCity = v.split('=')[1]; }
				else if (!oCity) oCity = a; else if (!oTemp && /^[fcFC]$/.test(a)) oTemp = a.toLowerCase(); else if (!oWind && /^[mkMK]$/.test(a)) oWind = a.toLowerCase();
			}
			const tempU = oTemp || String(cmd.getFlag('temp_unit'));
			const windU = oWind || String(cmd.getFlag('wind_speed_unit'));
			refresh(tempU, windU);
		},
	});

	cmd.hooks({onSessionStart: () => refresh(String(cmd.getFlag('temp_unit')), String(cmd.getFlag('wind_speed_unit'))), onSessionEnd: () => { clearInterval(intervalId); cmd.ui.setStatus(null); widgetDisp?.dispose(); }});
}
