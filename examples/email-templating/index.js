var framework = require('partial.js');
var mail = require('partial.js/mail');
var http = require('http');

var port = 8004;
var debug = true;

framework.run(http, debug, port);

framework.mail = function(email, name, params) {

	var self = this;
	
	var subject = '';

	switch (name) {
		case 'hello':
			subject = 'Hello!';
			break;
		case 'registration':
			subject = 'New registration';
			break;
	}

	if (subject.length === 0)
		return false;

	var body = self.resource('en', 'mail-' + name, '');
	var template = self.resource('en', 'mail', '').replace('{body}', body.params(params));

	// mail.send(smtp, mailFrom, mailTo, mailCC, subject, body, [senderName], [mailReply], [userName], [userPassword]);
	// mail.debug = true;
	mail.send(self.config['mail-smtp'], self.config['mail-from'], email, null, subject, template, self.config['mail-from-name']);
	return true;
};

console.log("http://127.0.0.1:{0}/".format(port));