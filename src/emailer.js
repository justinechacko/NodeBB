'use strict';

var async = require('async');
var winston = require('winston');
var nconf = require('nconf');
var Benchpress = require('benchpressjs');
var nodemailer = require('nodemailer');
var sendmailTransport = require('nodemailer-sendmail-transport');
var smtpTransport = require('nodemailer-smtp-transport');
var htmlToText = require('html-to-text');
var url = require('url');

var User = require('./user');
var Plugins = require('./plugins');
var meta = require('./meta');
var translator = require('./translator');
var pubsub = require('./pubsub');

var transports = {
	sendmail: nodemailer.createTransport(sendmailTransport()),
	gmail: undefined,
};

var app;
var fallbackTransport;

var Emailer = module.exports;

Emailer._defaultPayload = {};

Emailer.registerApp = function (expressApp) {
	app = expressApp;

	Emailer._defaultPayload = {
		url: nconf.get('url'),
		site_title: meta.config.title || 'NodeBB',
		logo: {
			src: meta.config['brand:logo'] ? nconf.get('url') + meta.config['brand:logo'].replace('.png', '-x50.png') : null,
			height: meta.config['brand:emailLogo:height'],
			width: meta.config['brand:emailLogo:width'],
		},
	};

	// Enable Gmail transport if enabled in ACP
	if (parseInt(meta.config['email:GmailTransport:enabled'], 10) === 1) {
		transports.gmail = nodemailer.createTransport(smtpTransport({
			host: 'smtp.gmail.com',
			port: 465,
			secure: true,
			auth: {
				user: meta.config['email:GmailTransport:user'],
				pass: meta.config['email:GmailTransport:pass'],
			},
		}));
		fallbackTransport = transports.gmail;
	} else {
		fallbackTransport = transports.sendmail;
	}

	// Update default payload if new logo is uploaded
	pubsub.on('config:update', function (config) {
		if (config) {
			Emailer._defaultPayload.logo.height = config['brand:emailLogo:height'];
			Emailer._defaultPayload.logo.width = config['brand:emailLogo:width'];
		}
	});

	return Emailer;
};

Emailer.send = function (template, uid, params, callback) {
	callback = callback || function () {};
	if (!app) {
		winston.warn('[emailer] App not ready!');
		return callback();
	}

	// Combined passed-in payload with default values
	params = Object.assign({}, Emailer._defaultPayload, params);

	async.waterfall([
		function (next) {
			async.parallel({
				email: async.apply(User.getUserField, uid, 'email'),
				settings: async.apply(User.getSettings, uid),
			}, next);
		},
		function (results, next) {
			if (!results.email) {
				winston.warn('uid : ' + uid + ' has no email, not sending.');
				return next();
			}
			params.uid = uid;
			Emailer.sendToEmail(template, results.email, results.settings.userLang, params, next);
		},
	], callback);
};

Emailer.sendToEmail = function (template, email, language, params, callback) {
	callback = callback || function () {};

	var lang = language || meta.config.defaultLang || 'en-GB';

	async.waterfall([
		function (next) {
			async.parallel({
				html: function (next) {
					renderAndTranslate('emails/' + template, params, lang, next);
				},
				subject: function (next) {
					translator.translate(params.subject, lang, function (translated) {
						next(null, translated);
					});
				},
			}, next);
		},
		function (results, next) {
			var data = {
				_raw: params,
				to: email,
				from: meta.config['email:from'] || 'no-reply@' + getHostname(),
				from_name: meta.config['email:from_name'] || 'NodeBB',
				subject: results.subject,
				html: results.html,
				plaintext: htmlToText.fromString(results.html, {
					ignoreImage: true,
				}),
				template: template,
				uid: params.uid,
				pid: params.pid,
				fromUid: params.fromUid,
			};
			Plugins.fireHook('filter:email.modify', data, next);
		},
		function (data, next) {
			if (Plugins.hasListeners('filter:email.send')) {
				Plugins.fireHook('filter:email.send', data, next);
			} else {
				Emailer.sendViaFallback(data, next);
			}
		},
	], function (err) {
		if (err && err.code === 'ENOENT') {
			callback(new Error('[[error:sendmail-not-found]]'));
		} else {
			callback(err);
		}
	});
};

Emailer.sendViaFallback = function (data, callback) {
	// Some minor alterations to the data to conform to nodemailer standard
	data.text = data.plaintext;
	delete data.plaintext;

	// NodeMailer uses a combined "from"
	data.from = data.from_name + '<' + data.from + '>';
	delete data.from_name;

	winston.verbose('[emailer] Sending email to uid ' + data.uid + ' (' + data.to + ')');
	fallbackTransport.sendMail(data, function (err) {
		if (err) {
			winston.error(err);
		}
		callback();
	});
};

function render(tpl, params, next) {
	var customTemplate = meta.config['email:custom:' + tpl.replace('emails/', '')];
	if (customTemplate) {
		Benchpress.compileParse(customTemplate, params, next);
	} else {
		app.render(tpl, params, next);
	}
}

function renderAndTranslate(tpl, params, lang, callback) {
	render(tpl, params, function (err, html) {
		translator.translate(html, lang, function (translated) {
			callback(err, translated);
		});
	});
}

function getHostname() {
	var configUrl = nconf.get('url');
	var parsed = url.parse(configUrl);

	return parsed.hostname;
}
