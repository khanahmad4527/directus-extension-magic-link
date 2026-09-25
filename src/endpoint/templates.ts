// Used when EMAIL_TEMPLATES_PATH has no matching template. `t` holds the translated strings.

const paragraph = (text: string, style = 'margin:24px 0 0;font-size:14px;line-height:20px;color:#525252;') =>
	`<p style="${style}">${text}</p>`;

function layout(content: string): string {
	return `<!DOCTYPE html>
<html lang="{{ t.locale }}">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{{ projectName | escape }}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;">
<tr><td style="background:{{ projectColor }};border-radius:12px 12px 0 0;padding:24px 32px;">
<img src="{{ projectLogo }}" alt="{{ projectName | escape }}" height="32" style="height:32px;border:0;display:block;" />
</td></tr>
<tr><td style="padding:32px;">
${content}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export const LINK_HTML_TEMPLATE =
	layout(`<h1 style="margin:0 0 16px;font-size:24px;line-height:32px;color:#171717;">{{ t.heading | escape }}</h1>
${paragraph('{{ t.greeting | escape }} {{ t.intro | escape }}', 'margin:0 0 24px;font-size:16px;line-height:24px;color:#525252;')}
<a href="{{ url }}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;border-radius:8px;background:{{ projectColor }};color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;">{{ t.button | escape }}</a>
${paragraph('{{ t.expiry | escape }} {{ t.ignore | escape }}')}
${paragraph('{{ t.fallbackLink | escape }}<br />{{ url }}', 'margin:24px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;word-break:break-all;')}`);

export const LINK_TEXT_TEMPLATE = `{{ t.heading }}

{{ t.greeting }}
{{ t.textIntro }}
{{ url }}

{{ t.expiry }}
{{ t.ignore }}`;

export const INACTIVE_HTML_TEMPLATE =
	layout(`<h1 style="margin:0 0 16px;font-size:24px;line-height:32px;color:#171717;">{{ t.inactiveHeading | escape }}</h1>
${paragraph('{{ t.greeting | escape }} {{ t.inactiveIntro | escape }}', 'margin:0 0 16px;font-size:16px;line-height:24px;color:#525252;')}
${paragraph('{{ t.inactiveAction | escape }}', 'margin:0;font-size:16px;line-height:24px;color:#525252;')}
${paragraph('{{ t.ignore | escape }}')}`);

export const INACTIVE_TEXT_TEMPLATE = `{{ t.inactiveHeading }}

{{ t.greeting }}
{{ t.inactiveIntro }}
{{ t.inactiveAction }}

{{ t.ignore }}`;
