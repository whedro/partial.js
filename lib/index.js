// Copyright Peter Širka, Web Site Design s.r.o. (www.petersirka.sk)
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var javascript = require('./javascript');
var less = require('./less');
var qs = require('querystring');
var os = require('os');
var fs = require('fs');
var zlib = require('zlib');
var path = require('path');
var urlParser = require('url');
var utils = require('./utils');
var events = require('events');
var internal = require('./internal');
var controller = require('./controller');
var subscribe = require('./subscribe');
var bk = require('./backup');
var encoding = 'utf8';
var directory = process.cwd();
var _controller = '';
var nosql = require('./nosql');

require('./prototypes');

// 1. Framework
// 2. Subscribe
// 3. Controller
// 4. res.end();

function Framework() {
	this.version = 1231;

	this.config = {
		debug: false,
		
		name: 'partial.js',
		version: '1.01',
		secret: os.hostname() + '-' + os.platform() + '-' + os.arch(),

		'etag-version': '1',

		'directory-contents': '/contents/',
		'directory-controllers': '/controllers/',
		'directory-views': '/views/',
		'directory-temp': '/tmp/',
		'directory-templates': '/templates/',
		'directory-resources': '/resources/',
		'directory-public': '/public/',
		'directory-modules': '/modules/',
		'directory-logs': '/logs/',
		'directory-tests': '/tests/',
		'directory-databases': '/databases/',
		'directory-backup': '/backup/',

		// all HTTP static request are routed to directory-public
		'static-url': '',
		'static-url-js': '/js/',
		'static-url-css': '/css/',
		'static-url-image': '/img/',
		'static-url-video': '/video/',
		'static-url-font': '/font/',
		'static-url-document': '/upload/',
		'static-accepts': ['.jpg', '.png', '.gif', '.ico', '.js', '.css', '.txt', '.xml', '.woff', '.ttf', '.eot', '.svg', '.zip', '.rar', '.pdf', '.docx', '.xlsx', '.doc', '.xls', '.html', '.htm'],

		// 'static-accepts-custom': [],

		'default-layout': '_layout',

		// default maximum request size / length
		// default 5 kB
		'default-request-length': 1024 * 5
	};

	this.global = {};
	this.resources = {};

	// routing to controllers
	this.routes = [];

	// routing to handlers
	this.routesFile = [];
	this.helpers = {};
	this.modules = {};
	this.controllers = {};
	this.tests = {};
	this.lastError = null;
	this.server = null;
	this.port = 0;
	this.static = {};
	this.staticRange = {};
	this.databases = {};

	// intialize cache
	this.cache = require('./cache').init(this);

	this.cache.on('service', function(count) {

		var self = this.app;

		if (self.config.debug) {
			
			// every minute clear the resource
			self.resources = {};

		} else {

			// every 20 minute clear resources and reconfigure framework
			if (count % 20 === 0) {
				self.resources = {};
				self.databases = {};
				self.configure();
			}

			// every 5 minute clear static cache
			if (count % 5 === 0) {
				self.static = {};
				self.staticRange = {};
			}
		}

		self.emit('service', count);
	});

	var self = this;
};

// ======================================================
// PROTOTYPES
// ======================================================

Framework.prototype = new events.EventEmitter;

/*
	Add/Register a new controller
	@name {String}
*/
Framework.prototype.controller = function(name) {

	var self = this;

	// is controller initialized?
	if (self.controllers[name])
		return self;

	// get controller name to internal property
	_controller = name;

	// initialize controller
	var obj = require(path.join(directory, self.config['directory-controllers'], name + '.js'));
	
	self.controllers[name] = obj;
	
	if (obj.install) {
		obj.install.call(self, self);
		return self;
	}

	if (obj.init) {
		obj.init.call(self, self);
		return self;
	}

	return self;
};

Framework.prototype.routeSort = function() {
	var self = this;
	self.routes.sort(function(a, b) {
		if (a.priority > b.priority)
			return -1;

		if (a.priority < b.priority)
			return 1;

		return 0;
	});	
	return self;
};

/*
	@name {String} :: file name of database
	@changes {Boolean} :: optional, default true
	return {nosql}
*/
Framework.prototype.database = function(name, changes) {

	var self = this;

	var db = self.databases[name];
	if (typeof(db) !== 'undefined')
		return db;

	db = nosql.load(path.join(directory, this.config['directory-databases'], name), path.join(directory, this.config['directory-databases'], name + '-binary'), changes);
	self.databases[name] = db;

	return db;
};

/*
	Stop the server and exit
	return {Framework}
*/
Framework.prototype.stop = function(code) {
	var self = this;

	if (typeof(process.send) === 'function')
		process.send('stop');

	self.cache.stop();
	self.server.close();

	process.exit(code || 0);
	return self;
};

/*
	Add a new route
	@url {String}
	@funcExecute {Function}
	@flags {String array}
	@maximumSize {Number}
	@funcValidation {Function} :: params: {req}, {res}, {flags} return {Boolean};
	return {Framework}
*/
Framework.prototype.route = function(url, funcExecute, flags, maximumSize, funcValidation) {

	if (_controller === '') {
		throw new Error('Route must be defined in controller.');
		return;
	}

	var self = this;
	var priority = 0;

	if (typeof(funcValidation) === 'number') {
		maximumSize = funcValidation;
		funcValidation = null;
	}

	var index = url.indexOf(']');
	var subdomain = null;

	priority = url.count('/');
	
	if (index > 0) {
		subdomain = url.substring(1, index).trim().toLowerCase().split(',');
		url = url.substring(index + 1);
		priority += 2;
	}

	if (flags) {
		for (var i = 0; i < flags.length; i++)
			flags[i] = flags[i].toString().toLowerCase();

		priority += (flags.length * 2);
	}

	var routeURL = internal.routeSplit(url.trim());
	var arr = [];
	
	if (url.indexOf('{') !== -1) {
		routeURL.forEach(function(o, i) {
			if (o.substring(0, 1) === '{')
				arr.push(i);
		});

		priority -= arr.length;
	}

	if (url.indexOf('#') !== -1)
		priority--;

	self.routes.push({ priority: priority, subdomain: subdomain, name: _controller, url: routeURL, param: arr, flags: flags || [], onExecute: funcExecute, onValidation: funcValidation || null, maximumSize: maximumSize || self.config['default-request-length'] });
	return self;
};

/*
	Add a new file route
	@name {String}
	@funcValidation {Function} :: params: {req}, {res}, return {Boolean};
	@funcExecute {Function} :: params: {req}, {res};
	return {Framework}
*/
Framework.prototype.routeFile = function(name, funcValidation, funcExecute) {
	var self = this;
	self.routesFile.push({ controller: _controller, name: name, onValidation: funcValidation, onExecute: funcExecute });
	return self;
};

/*
	Error caller
	@err {Error}
	@name {String} :: name of controller
	return {Framework}
*/
Framework.prototype.error = function(err, name, uri) {
	var self = this;
	self.lastError = name + ' | ' + err + ' | ' + (uri ? uri.href : '');
	self.onError(err, name, uri);
	return self;
};

/*
	Return path to web application directory
	@arguments {String params}
	return {String}
*/
Framework.prototype.path = function() {
	var self = this;

	if (arguments.length === 0)
		return directory;

	var params = [];
	params.push(directory);

	for (var i = 0; i < arguments.length; i++)
		params.push(arguments[i]);

	return path.join.apply(self, params).replace(/\\/g, '/');
};

/*
	Get path
	@name {String}
	return {String}
*/
Framework.prototype.pathTemp = function(name) {
	return utils.combine(this.config['directory-temp'], name).replace(/\\/g, '/');
};

/*
	Get path
	@name {String}
	return {String}
*/
Framework.prototype.pathPublic = function(name) {
	return utils.combine(this.config['directory-public'], name).replace(/\\/g, '/');
};

/*
	Module caller
	@name {String}
	return {Object} :: framework return require();
*/
Framework.prototype.module = function(name) {

	var self = this;
	var module = self.modules[name];

	if (typeof(module) !== 'undefined')
		return module;
	
	var fileName = path.join(directory, self.config['directory-modules'], name + '.js');

	if (!fs.existsSync(fileName)) {
		
		fileName = path.join(directory, self.config['directory-modules'], name, 'index.js');
		if (fs.existsSync(fileName))
			module = require(fileName);

	} else
		module = require(fileName);

	if (typeof(module) === 'undefined')
		module = null;
	
	_controller = '#module-' + name;

	if (module !== null && typeof(module.directory) === 'undefined')
		module.directory = path.join(directory, self.config['directory-modules']);

	self.modules[name] = module;

	return module;
};

/*
	Install/Init modules
	return {Framework}
*/
Framework.prototype.install = function() {

	var self = this;
	var dir = path.join(directory, self.config['directory-controllers']);

	if (fs.existsSync(dir)) {
		fs.readdirSync(dir).forEach(function(o) {

			var ext = path.extname(o);
			if (ext.toLowerCase() !== '.js')
				return;
			
			self.controller(o.substring(0, o.length - 3));
		});
	}

	dir = path.join(directory, self.config['directory-modules']);

	if (!fs.existsSync(dir)) {
		self.routeSort();
		return self;
	}

	fs.readdirSync(dir).forEach(function(o) {

		var ext = path.extname(o);

		var isDirectory = fs.statSync(path.join(dir + o)).isDirectory();
		if (!isDirectory && ext.toLowerCase() !== '.js')
			return;

		var name = o.replace(ext, '');

		if (name === '#')
			return;

		var module = self.module(name);

		if (module === null || typeof(module.install) === 'undefined')
			return;

		try
		{
			module.install(self);
		} catch (err) {
			self.error(err, name);
		}
	});

	self.routeSort();
	return self;
};

/*
	Backup website directory
	@callback {Function} :: optional, param: param: @err {Error}, @filename {String}
	return {Framework}
*/
Framework.prototype.backup = function(callback) {

	var self = this;
	var backup = new bk.Backup();

	var filter = function(path) {

		if (path === '/tmp/' || path === '/backup/')
			return true;

		if (path.indexOf('.DS_Store') !== -1)
			return false;

		if (path.indexOf('/backup/') === 0)
			return false;

		if (path.indexOf('/tmp/') === 0)
			return false;

		if (path.indexOf('.nosql-tmp') !== -1)
			return false;

		if (path === '/keepalive.js')
			return false;

		return self.onFilterBackup(path);
	};

	backup.directory.push('/backup/');
	backup.directory.push('/tmp/');

	var directoryBackup = path.join(directory, self.config['directory-backup']);

	if (!fs.existsSync(directoryBackup))
		fs.mkdirSync(directoryBackup);

	backup.backup(directory, path.join(directoryBackup, new Date().format('yyyy-MM-dd') + '.backup'), callback, filter);
	return self;
};

/*
	Restore website directory
	@date {String} :: yyyy-MM-dd
	@callback {Function} :: optional, param: @err {Error}, @path {String}
	@restorePath {String} :: optional, path to restore website
	return {Framework}
*/
Framework.prototype.restore = function(date, callback, restorePath) {

	var self = this;
	var dir = restorePath || directory;

	var tmpDirectory = path.join(dir, self.config['directory-temp']);

	if (!fs.existsSync(tmpDirectory))
		fs.mkdirSync(tmpDirectory);

	var fileName = path.join(dir, self.config['directory-backup'], date + (date.indexOf('.backup') === -1 ? '.backup' : ''));

	var cb = function(err, path) {
		
		if (typeof(process.send) === 'function')
			process.send('restore');
		
		callback && callback(err, path);
	};

	if (!fs.existsSync(fileName))
		return cb(new Error('Backup file not found.'), dir);

	var filter = function(path) {

		if (path === '/tmp/' || path === '/backup/')
			return true;

		if (path.indexOf('/backup/') === 0)
			return false;

		return self.onFilterRestore(path);
	};

	var filterClear = function(path) {
		if (path === '/tmp/' || path === '/backup/')
			return false;
		return;
	};

	var backup = new bk.Backup();

	backup.clear(dir, function() {
		backup.restore(fileName, dir, cb, filter);
	}, filterClear);
	
	return self;
};

/*
	Error Handler
	@err {Error}
	@name {String} :: name of Controller (optional)
	@uri {Uri} :: optional
*/
Framework.prototype.onError = function(err, name, uri) {
	console.log(err, name, uri);
	console.log('--------------------------------------------------------------------');
	return this;
};

/*
	Authorization handler
	@req {ServerRequest}
	@res {ServerResponse}
	@flags {String array}
	@callback {Function} - @callback(Boolean), true if logged and false if unlogged
*/
Framework.prototype.onAuthorization = null;

/*
	Prefix delegate
	@req {ServerRequest}
	return {String}; :: return prefix (default return empty string)
*/
Framework.prototype.onPrefix = null;

/*
	Versioning static files (this delegate call LESS CSS by the background property)
	@name {String} :: name of static file (style.css or script.js)
	return {String}; :: return new name of static file (style-new.css or script-new.js)
*/
Framework.prototype.onVersion = null;

/*
	Route validator / Request restriction
	@req {ServerRequest}
	@res {ServerResponse}
	return {Boolean};
*/
Framework.prototype.onRoute = null;

/*
	Global framework validation
	@name {String}
	@value {String}
	return {Boolean or utils.isValid() or StringErrorMessage};
*/
Framework.prototype.onValidation = null;

/*
	Render HTML for views
	@argument {String params}

	this === controller

	return {String}
*/
Framework.prototype.onSettings = function() {
	return '';
};

/*
	Backup Filter
	@path {String}
	return {Boolean}
*/
Framework.prototype.onFilterBackup = function(path) {
	return true;
};

/*
	Restore Filter
	@path {String}
	return {Boolean}
*/
Framework.prototype.onFilterRestore = function(path) {
	return true;
};

/*
	Render HTML for views
	@argument {String params}

	this === controller

	return {String}
*/
Framework.prototype.onMeta = function() {
	
	var self = this;
	var builder = '';

	for (var i = 0; i < arguments.length; i++) {

		var arg = utils.htmlEncode(arguments[i]);
		if (arg === null || arg.length === 0)
			continue;

		switch (i) {
			case 0:
				builder += '<title>{0}</title>'.format(arg + (self.url !== '/' ? ' - ' + self.config['name'] : ''));
				break;
			case 1:
				builder += '<meta name="description" content="{0}" />'.format(arg);
				break;
			case 2:
				builder += '<meta name="keywords" content="{0}" />'.format(arg);
				break;
			case 3:
				builder += '<link rel="image_src" type="image/jpeg" href="{0}" />'.format(arg);
				break;
		}
	}

	return builder;
};

/*
	Create file with CSS (client side)
	@name {String}
	@content {String}
	@rewrite {Boolean} :: optional (default false)
	@append {Boolean} :: optional (default false)
	return {Boolean}
*/
Framework.prototype.createCSS = function(name, content, rewrite, append) {

	var self = this;	

	if ((content || '').length === 0)
		return false;

	if (name.indexOf('.css') === -1)
		name += '.css';

	var fileName = utils.combine(self.config['directory-public'], self.config['static-url-css'], name);
	return self.createFile(fileName, content, append, rewrite);
};

/*
	Create file with JavaScript (client side)
	@name {String}
	@content {String}
	@rewrite {Boolean} :: optional (default false)
	@append {Boolean} :: optional (default false)
	return {Boolean}
*/
Framework.prototype.createJS = function(name, content, rewrite, append) {

	var self = this;

	if ((content || '').length === 0)
		return false;

	if (name.indexOf('.js') === -1)
		name += '.js';

	var fileName = utils.combine(self.config['directory-public'], self.config['static-url-js'], name);
	return self.createFile(fileName, content, append, rewrite);
};

/*
	Create file with template
	@name {String}
	@content {String}
	@rewrite {Boolean} :: optional (default false)
	@append {Boolean} :: optional (default false)
	return {Boolean}
*/
Framework.prototype.createTemplate = function(name, content, rewrite, append) {

	var self = this;

	if ((content || '').length === 0)
		return false;

	if (name.indexOf('.html') === -1)
		name += '.html';

	var fileName = utils.combine(self.config['directory-templates'], name);
	return self.createFile(fileName, content, append, rewrite);
};

/*
	Create file with view
	@name {String}
	@content {String}
	@rewrite {Boolean} :: optional (default false)
	@append {Boolean} :: optional (default false)
	return {Boolean}
*/
Framework.prototype.createView = function(name, content, rewrite, append) {

	var self = this;

	if ((content || '').length === 0)
		return false;

	if (name.indexOf('.html') === -1)
		name += '.html';

	var fileName = utils.combine(self.config['directory-views'], name);
	return self.createFile(fileName, content, append, rewrite);
};

/*
	Create file with content
	@name {String}
	@content {String}
	@rewrite {Boolean} :: optional (default false)
	@append {Boolean} :: optional (default false)
	return {Boolean}
*/
Framework.prototype.createContent = function(name, content, rewrite, append) {

	var self = this;

	if ((content || '').length === 0)
		return false;

	if (name.indexOf('.html') === -1)
		name += '.html';

	var fileName = utils.combine(self.config['directory-contents'], name);
	return self.createFile(fileName, content, append, rewrite);
};

/*
	Create file with resource
	@name {String}
	@content {String or Object}
	@rewrite {Boolean} :: optional (default false)
	@append {Boolean} :: optional (default false)
	return {Boolean}
*/
Framework.prototype.createResource = function(name, content, rewrite, append) {

	var self = this;

	if ((content || '').length === 0)
		return false;

	if (name.indexOf('.resource') === -1)
		name += '.resource';

	var builder = content;

	if (typeof(content) === 'object') {
		builder = '';
		Object.keys(content).forEach(function(o) {
			builder += o.padRight(20, ' ') + ': ' + content[o] + '\n';
		});
	}

	var fileName = utils.combine(self.config['directory-resources'], name);
	return self.createFile(fileName, builder, append, rewrite);
};

/*
	Create file with content
	@fileName {String}
	@content {String}
	@append {Boolean}
	@rewrite {Boolean}
	return {Boolean}
*/
Framework.prototype.createFile = function(fileName, content, append, rewrite) {

	var self = this;

	if ((content || '').length === 0)
		return false;

	var exists = fs.existsSync(fileName);

	if (exists && append)
	{
		var data = fs.readFileSync(fileName).toString(encoding);

		if (data.indexOf(content) === -1) {
			fs.appendFileSync(fileName, '\n' + content);
			return true;
		}

		return false;
	}

	if (exists && !rewrite)
		return false;

	fs.writeFileSync(fileName, content, encoding);
	return true;
};

/*
	Delete file of CSS
	@name {String}
	return {Boolean}
*/
Framework.prototype.deleteCSS = function(name) {
	var self = this;

	if (name.indexOf('.css') === -1)
		name += '.css';

	var fileName = utils.combine(self.config['directory-public'], self.config['static-url-css'], name);
	return self.deleteFile(fileName);
};

/*
	Delete file of JS
	@name {String}
	return {Boolean}
*/
Framework.prototype.deleteJS = function(name) {
	var self = this;

	if (name.indexOf('.js') === -1)
		name += '.js';

	var fileName = utils.combine(self.config['directory-public'], self.config['static-url-js'], name);
	return self.deleteFile(fileName);
};

/*
	Delete file of view
	@name {String}
	return {Boolean}
*/
Framework.prototype.deleteView = function(name) {
	var self = this;

	if (name.indexOf('.html') === -1)
		name += '.html';

	var fileName = utils.combine(self.config['directory-views'], name);
	return self.deleteFile(fileName);
};

/*
	Delete file of content
	@name {String}
	return {Boolean}
*/
Framework.prototype.deleteContent = function(name) {
	var self = this;

	if (name.indexOf('.html') === -1)
		name += '.html';

	var fileName = utils.combine(self.config['directory-contents'], name);
	return self.deleteFile(fileName);
};

/*
	Delete file of template
	@name {String}
	return {Boolean}
*/
Framework.prototype.deleteTemplate = function(name) {
	var self = this;

	if (name.indexOf('.html') === -1)
		name += '.html';

	var fileName = utils.combine(self.config['directory-templates'], name);
	return self.deleteFile(fileName);
};

/*
	Delete file of resource
	@name {String}
	return {Boolean}
*/
Framework.prototype.deleteResource = function(name) {
	var self = this;

	if (name.indexOf('.resource') === -1)
		name += '.resource';

	var fileName = utils.combine(self.config['directory-resources'], name);
	return self.deleteFile(fileName);
};

/*
	Delete file
	@name {String}
	return {Boolean}
*/
Framework.prototype.deleteFile = function(fileName) {
	var self = this;

	if (!fs.existsSync(fileName))
		return false;

	fs.unlink(fileName);
	return true;
};

// @arguments {Object params}
Framework.prototype.log = function() {

	var self = this;
	var now = new Date();
	var fileName = now.getFullYear() + '-' + (now.getMonth() + 1).toString().padLeft(2, '0') + '-' + now.getDate().toString().padLeft(2, '0');
	var time = now.getHours().toString().padLeft(2, '0') + ':' + now.getMinutes().toString().padLeft(2, '0') + ':' + now.getSeconds().toString().padLeft(2, '0');
	var str = '';

	for (var i = 0; i < arguments.length; i++)
		str += (str.length > 0 ? ' ' : '') +  (arguments[i] || '');

	fs.appendFile(utils.combine(self.config['directory-logs'], fileName + '.log'), time + ' | ' + str + '\n');

	return self;
};

/*
	Return string of framework usage information
	@detailed {Boolean} :: default (false)
	return {String}
*/
Framework.prototype.usage = function(detailed) {
	var memory = process.memoryUsage();
	var builder = [];
	var self = this;

	var cache = Object.keys(self.cache.repository);
	var resources = Object.keys(self.resources);
	var controllers = Object.keys(self.controllers);
	var modules = Object.keys(self.modules);
	var helpers = Object.keys(self.helpers);
	var static = Object.keys(self.static);
	var staticRange = Object.keys(self.staticRange);

	var size = 0;
	var sizeBackup = 0;
	var sizeDatabase = 0;
	var dir = '.' + self.config['directory-temp'];

	if (fs.existsSync(dir)) {
		fs.readdirSync(dir).forEach(function(o) {
			size += fs.statSync(utils.combine(self.config['directory-temp'], o)).size;
		});
	}

	dir = '.' + self.config['directory-backup'];

	if (fs.existsSync(dir)) {
		fs.readdirSync(dir).forEach(function(o) {
			sizeBackup += fs.statSync(utils.combine(self.config['directory-backup'], o)).size;
		});
	}	

	dir = '.' + self.config['directory-databases'];
	
	if (fs.existsSync(dir)) {
		fs.readdirSync(dir).forEach(function(o) {
			sizeDatabase += fs.statSync(utils.combine(self.config['directory-databases'], o)).size;
		});
	}

	builder.push('Platform: {0}'.format(process.platform));
	builder.push('Processor: {0}'.format(process.arch));
	builder.push('PID: {0}'.format(process.pid));
	builder.push('Node version: {0}'.format(process.version));
	builder.push('Framework version: {0}'.format(self.version));
	builder.push('Current directory: {0}'.format(process.cwd));
	builder.push('Service run: {0}x'.format(self.cache.count));
	builder.push('-------------------------------------------------------');
	builder.push('Uptime: {0} minutes'.format(Math.floor(process.uptime() / 60)));
	builder.push('Memory usage: total {0} MB, used {1} MB'.format((memory.heapTotal / 1024 / 1024).floor(2), (memory.heapUsed / 1024 / 1024).floor(2)));
	builder.push('-------------------------------------------------------');
	builder.push('Temporary directory: {0} kB'.format((size / 1024).floor(2)));
	builder.push('Backup directory: {0} kB'.format((sizeBackup / 1024).floor(2)));
	builder.push('Databases directory: {0} kB'.format((sizeDatabase / 1024).floor(2)));
	builder.push('Controller count: {0}'.format(controllers.length));
	builder.push('Module count: {0}'.format(modules.length));
	builder.push('Cache: {0} items'.format(cache.length, self.cache.count));
	builder.push('Resource count: {0}'.format(resources.length));
	builder.push('Route count: {0}'.format(self.routes.length));
	builder.push('Helper count: {0}'.format(helpers.length));
	builder.push('Static files count: {0}'.format(static.length));
	builder.push('Static files / streaming count: {0}'.format(staticRange.length));
	builder.push('-------------------------------------------------------');
	builder.push('Last error: {0}'.format(self.lastError));

	if (!detailed)
		return builder.join('\n');

	builder.push('-------------------------------------------------------');
	builder.push('');
	builder.push('============ [Controllers]');

	controllers.forEach(function(o) {

		builder.push('');
		builder.push('[' + o + ']');
		
		var controller = self.controllers[o];

		if (typeof(controller.usage) === 'undefined')
			return;

		builder.push((controller.usage() || '').toString());

	});

	if (modules.length > 0) {
		builder.push('');
		builder.push('============ [Modules]');

		modules.forEach(function(o) {

			builder.push('');
			builder.push('[' + o + ']');

			var module = self.modules[o];

			if (module === null || typeof(module.usage) === 'undefined')
				return;

			builder.push((module.usage() || '').toString());
		});
	}

	if (helpers.length > 0) {
		builder.push('');
		builder.push('============ [Helpers]');

		helpers.forEach(function(o) {
			builder.push('{0}'.format(o).indent(4));
		});
	}

	if (cache.length > 0) {
		builder.push('');
		builder.push('============ [Cache items]');

		cache.forEach(function(o) {
			builder.push('{0}'.format(o).indent(4));
		});
	}

	if (resources.length > 0) {
		builder.push('');
		builder.push('============ [Resources]');

		resources.forEach(function(o) {
			builder.push('{0}.resource'.format(o).indent(4));
		});
	}

	if (static.length > 0) {
		builder.push('');
		builder.push('============ [Static files]');

		static.forEach(function(o) {
			builder.push('{0}'.format(o).indent(4));
		});
	}

	if (staticRange.length > 0) {
		builder.push('');
		builder.push('============ [Static files / Streaming]');

		staticRange.forEach(function(o) {
			builder.push('{0} / {1}'.format(o, (self.staticRange[o] / 1024).floor(2)).indent(4));
		});
	}

	return builder.join('\n');
};

/*
	Automatic serve static files
	@req {ServerRequest}
	@res {ServerResponse}
	return {Framework}
*/
Framework.prototype.onStatic = function(req, res) {
	var self = this;
	self.responseStatic(req, res);
	return self;
};

/*
	Compile JavaScript and CSS
	@req {ServerRequest}
	@fileName {String}
	return {String or NULL};
*/
Framework.prototype.compileStatic = function(req, fileName) {

	if (!fs.existsSync(fileName))
		return null;

	var self = this;
	var index = fileName.lastIndexOf('.');
	var ext = fileName.substring(index).toLowerCase();
	var output = fs.readFileSync(fileName).toString(encoding);

	switch (ext) {
		case '.js':
			output = javascript.compile(output, self);
			break;
		
		case '.css':
			output = less.compile(output);

			if (self.onVersion !== null) {
				var matches = output.match(/url\(.*?\)/g);
				if (matches !== null) {
					matches.forEach(function(o) {
						var url = o.substring(4, o.length - 1);
						output = output.replace(o, 'url('+ self.onVersion(url) +')');
					});
				}
			}

			break;
	}

	var fileComiled = utils.combine(self.config['directory-temp'], req.url.replace(/\//g, '-').substring(1));
	fs.writeFileSync(fileComiled, output);

	return fileComiled;
};

/*
	Automatic serve static files
	@req {ServerRequest}
	@res {ServerResponse}
	return {Framework}
*/
Framework.prototype.responseStatic = function(req, res) {
	
	var self = this;

	if (res.isFlush)
		return self;

	var name = req.url;
	var index = name.indexOf('?');

	if (index !== -1)
		name = name.substring(0, index);

	var fileName = utils.combine(self.config['directory-public'], name);
	self.responseFile(req, res, fileName, '');
	return self;
};

/*
	Response file
	@req {ServerRequest}
	@res {ServerResponse}
	@filename {String}
	@downloadName {String} :: optional
	@headers {Object} :: optional key/value
	return {Framework}
*/
/*
	Response file
	@req {ServerRequest}
	@res {ServerResponse}
	@fileName {String}
	@downloadName {String} :: optional
	@headers {Object} :: optional key/value
	return {Framework}
*/
Framework.prototype.responseFile = function(req, res, fileName, downloadName, headers) {

	var self = this;

	if (res.isFlush)
		return self;

	req.clear();

	var name = self.static[fileName];

	if (name === null) {
		self.response404(req, res);
		return self;
	}

	var etag = utils.etag(req.url, self.config['etag-version']);
	
	if (!self.config.debug) {
		if (req.headers['if-none-match'] === etag) {
			res.isFlush = true;
			res.writeHead(304);
			res.end();
			return self;
		}
	}

	var extension = path.extname(fileName).substring(1);

	if (self.config['static-accepts'].indexOf('.' + extension) === -1) {
		self.response404(req, res);
		return self;
	}

	if (typeof(name) === 'undefined') {

		if (!fs.existsSync(fileName)) {
			self.static[fileName] = null;
			self.response404(req, res);
			return self;
		}

		name = fileName;

		// compile JavaScript and CSS
		if (['js', 'css'].indexOf(extension) !== -1) {
			name = self.compileStatic(req, fileName);
			self.static[fileName] = name;
		}
		
		self.static[fileName] = name;

		if (self.config.debug)
			delete self.static[fileName];
	}

	var compress = ['js', 'css', 'txt'].indexOf(extension) !== -1;
	var accept = req.headers['accept-encoding'] || '';
	var returnHeaders = {};

	returnHeaders['Accept-Ranges'] = 'bytes';
	returnHeaders['Cache-Control'] = 'public';
	returnHeaders['Expires'] = new Date().add('d', 15);
	returnHeaders['Vary'] = 'Accept-Encoding';

	// možnosť odoslať vlastné hlavičky
	if (headers)
		utils.extend(returnHeaders, headers, true);

	downloadName = downloadName || '';

	if (downloadName.length > 0)
		returnHeaders['Content-Disposition'] = 'attachment; filename=' + downloadName;

	if (etag.length > 0)
		returnHeaders['Etag'] = etag;

	returnHeaders['Content-Type'] = utils.getContentType(extension);

	var range = req.headers['range'] || '';
	res.isFlush = true;

	if (range.length > 0)
		return self.responseRange(name, range, returnHeaders, res);

	if (compress) {

		if (accept.indexOf('gzip') !== -1) {
			returnHeaders['Content-Encoding'] = 'gzip';
			res.writeHead(200, returnHeaders);
			fs.createReadStream(name).pipe(zlib.createGzip()).pipe(res);
			return self;
		}

		// IE problem
		if (accept.indexOf('deflate') !== -1) {
			returnHeaders['Content-Encoding'] = 'deflate';
			res.writeHead(200, returnHeaders);
			fs.createReadStream(name).pipe(zlib.createDeflate()).pipe(res);
			return self;
		}			
	}

	res.writeHead(200, returnHeaders);
	fs.createReadStream(name).pipe(res);
	return self;
};

/*
	Response stream
	@req {ServerRequest}
	@res {ServerResponse}
	@contentType {String}
	@stream {ReadStream}
	@downloadName {String} :: optional
	@headers {Object} :: optional key/value
	return {Framework}
*/
Framework.prototype.responseStream = function(req, res, contentType, stream, downloadName, headers) {

	var self = this;

	if (res.isFlush)
		return self;

	req.clear();

	if (contentType.indexOf('/') === -1)
		contentType = utils.getContentType(contentType);

	var compress = ['text/plain', 'text/javascript', 'text/css', 'application/x-javascript', 'text/html'].indexOf(contentType) !== -1;
	var accept = req.headers['accept-encoding'] || '';
	var returnHeaders = {};

	returnHeaders['Cache-Control'] = 'public';
	returnHeaders['Expires'] = new Date().add('d', 15);
	returnHeaders['Vary'] = 'Accept-Encoding';

	// možnosť odoslať vlastné hlavičky
	if (headers)
		utils.extend(returnHeaders, headers, true);

	downloadName = downloadName || '';

	if (downloadName.length > 0)
		returnHeaders['Content-Disposition'] = 'attachment; filename=' + downloadName;

	returnHeaders['Content-Type'] = contentType;

	if (compress) {

		if (accept.indexOf('gzip') !== -1) {
			returnHeaders['Content-Encoding'] = 'gzip';
			res.writeHead(200, returnHeaders);
			stream.pipe(zlib.createGzip()).pipe(res);
			return self;
		}

		// IE problem
		if (accept.indexOf('deflate') !== -1) {
			returnHeaders['Content-Encoding'] = 'deflate';
			res.writeHead(200, returnHeaders);
			stream.pipe(zlib.createDeflate()).pipe(res);
			return self;
		}
	}
	
	stream.on('error', function() {
		self.response404(req, res);
	});

	res.writeHead(200, returnHeaders);
	stream.pipe(res);

	return self;
};

/*
	Internal :: Response Range
	@name {String}
	@range {String}
	@headers {Object}
	@res {ServerResponse}
	return {Framework}
*/
Framework.prototype.responseRange = function(name, range, headers, res) {

	var self = this;
	var arr = range.replace(/bytes=/, '').split('-');
	var beg = parseInt(arr[0] || '0');
	var end = parseInt(arr[1] || '0');
	var total = self.staticRange[name] || 0;

	if (total === 0) {
		// sync
		total = fs.statSync(name).size;
		self.staticRange[name] = total;
	}

	if (end === 0)
		end = total - 1;
	
	var length = (end - beg) + 1;

	headers['Content-Length'] = length;
	headers['Content-Range'] = 'bytes ' + beg + '-' + end + '/' + total;

	res.writeHead(206, headers);
	fs.createReadStream(name, { start: beg, end: end }).pipe(res);

	return self;
};

/*
	Set last modified header or Etag
	@req {ServerRequest}
	@res {ServerResponse}
	@value {String or Date}

	if @value === {String} set ETag
	if @value === {Date} set LastModified

	return {Controller};
*/
Framework.prototype.setModified = function(req, res, value) {
	
	var self = this;
	var isEtag = typeof(value) === 'string';

	if (isEtag) {
		res.setHeader('Etag', value + ':' + self.config['etag-version']);
		return self;
	}

	value = value || new Date();
	res.setHeader('Last-Modified', value.toUTCString());

	return self;
};

/*
	Check if ETag or Last Modified has modified
	@req {ServerRequest}
	@res {ServerResponse}
	@compare {String or Date}
	@strict {Boolean} :: if strict then use equal date else use great then date (default: false)

	if @compare === {String} compare if-none-match
	if @compare === {Date} compare if-modified-since

	this method automatically flush response (if not modified)
	--> response 304

	return {Controller};
*/
Framework.prototype.ifNotModified = function(req, res, compare, strict) {
	
	var self = this;
	var isEtag = typeof(compare) === 'string';

	var val = req.headers[isEtag ? 'if-none-match' : 'if-modified-since'];

	if (isEtag) {

		if (typeof(val) === 'undefined')
			return false;

		var myetag = compare + ':' + self.config['etag-version'];

		if (val !== myetag)
			return false;

	} else {

		if (typeof(val) === 'undefined')
			return false;

		var date = typeof(compare) === 'undefined' ? new Date().toUTCString() : compare.toUTCString();


		if (strict)
 		{			
			if (new Date(Date.parse(val)) === new Date(date))
				return false;
		} else {
			if (new Date(Date.parse(val)) < new Date(date))
				return false;
		}
	}

	res.isFlush = true;
	res.writeHead(304);
	res.end();

	return true;
};

/*
	Response with 404 error
	@req {ServerRequest}
	@res {ServerResponse}
	return {Framework}
*/
Framework.prototype.response404 = function(req, res) {
	
	if (res.isFlush)
		return this;

	req.clear();
	
	res.isFlush = true;
	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('File not found (404).');

	return this;
};

/*
	Response content
	@req {ServerRequest}
	@res {ServerResponse}
	@code {Number}
	@contentBody {String}
	@contentType {String}
	@compress {Boolean}
	@headers {Object} :: optional key/value
	return {Framework}
*/
Framework.prototype.responseContent = function(req, res, code, contentBody, contentType, compress, headers) {
	var self = this;

	if (res.isFlush)
		return self;

	req.clear();
	res.isFlush = true;

	var accept = req.headers['accept-encoding'] || '';
	var returnHeaders = {};

	returnHeaders['Cache-Control'] = 'private';
	returnHeaders['Vary'] = 'Accept-Encoding';

	// možnosť odoslať vlastné hlavičky
	if (headers)
		utils.extend(returnHeaders, headers, true);

	// Safari resolve
	if (contentType === 'application/json')
		returnHeaders['Cache-Control'] = 'no-cache';

	// pridáme UTF-8 do hlavičky
	if ((/text|application/).test(contentType))
		contentType += '; charset=utf-8';

	if (compress) {

		if (accept.indexOf('gzip') !== -1) {
			zlib.gzip(new Buffer(contentBody), function(err, data) {
				
				if (err) {
					req.connection.destroy();
					return;
				}

				returnHeaders['Content-Type'] = contentType;
				returnHeaders['Content-Encoding'] = 'gzip';

				res.writeHead(code, returnHeaders);
				res.end(data, encoding);
			});
			return self;
		}

		// problém pri IE, deflate nefunguje
		if (accept.indexOf('deflate') !== -1) {
			zlib.deflate(new Buffer(contentBody), function(err, data) {
				
				if (err) {
					req.connection.destroy();
					return;
				}

				returnHeaders['Content-Type'] = contentType;
				returnHeaders['Content-Encoding'] = 'deflate';

				res.writeHead(code, returnHeaders);
				res.end(data, encoding);
			});
			return self;
		}
	}

	returnHeaders['Content-Type'] = contentType;
	res.writeHead(code, returnHeaders);
	res.end(contentBody, encoding);

	return self;
};

/*
	Internal function
	@req {ServerRequest}
	@res {ServerResponse}
	@url {String}
	@permament {Boolean} :: optional
	return {Subscribe}
*/
Framework.prototype.responseRedirect = function(req, res, url, permament) {

	var self = this;

	if (res.isFlush)
		return self;

	res.isFlush = true;
	res.writeHead(permament ? 301 : 302, { 'Location': url });
	res.end();

	return self;
};

/*
	Initialization
	@http {HTTP or HTTPS}
	@config {Boolean or Object}
	@port {Number}
	return {Framework}
*/
Framework.prototype.init = function(http, config, port) {

	var self = this;

	if (self.server !== null)
		return;

	if (typeof(config) === 'boolean')
		self.config.debug = config;
	else if (typeof(config) === 'object')
		utils.extend(self.config, config, true);

	self.configure();
	self.clear();
	self.cache.init();
	self.install();

	var module = self.module('#');
	if (module !== null) {
		Object.keys(module).forEach(function(o) {
			if (o === 'onLoaded' || o === 'usage')
				return;
			self[o] = module[o];
		});
	}

	process.on('uncaughtException', function(e) {
		self.error(e, '', null);

		if (e.toString().indexOf('listen EADDRINUSE') !== -1) {
			if (typeof(process.send) === 'function')
				process.send('stop');
			process.exit(0);
		}

	});

	process.on('SIGTERM', function() {
	    self.stop();
	});

	process.on('SIGINT', function() {
	    self.stop();
	});

	process.on('exit', function () {
		
		if (self.onExit)
			self.onExit(self);

		self.emit('exit');
	});

	process.on('message', function(msg) {

		if (msg === 'backup') {
			self.backup();
			return;
		}

		if (msg === 'reset') {
			self.clear();
			self.cache.clear();
			return;
		}

		if (msg === 'stop' || msg === 'exit') {
			self.stop();
			return;
		}

		if (msg.indexOf('restore') !== -1) {
			self.restore(msg.substring(7).trim());
			return;
		}
	});

    self.server = http.createServer(function(req, res) {
		self._request(req, res);
	});

	self.port = port || 8000;
	self.server.listen(self.port);

	if (module !== null && typeof(module.onLoaded) !== 'undefined') {
		try
		{
			module.onLoaded.call(self, self);
		} catch (err) {
			self.error(err, 'Framework :: global module');
		}
	}

	try
	{
		self.emit('loaded', self);
	} catch (err) {
		self.error(err, 'Framework :: loaded event');
	}
	
	if (typeof(process.send) === 'function')
		process.send('name: ' + self.config.name);

	return self;
};

Framework.prototype._request = function(req, res) {
	var self = this;
	
	res.setHeader('X-Powered-By', 'partial.js v' + self.version);

    if (self.config.debug)
    	res.setHeader('Mode', 'debug');

	res.isFlush = false;
	req.data = { get: {}, post: {}, files: [] };
	req.buffer = { data: '', isExceeded: false, isData: false };
	req.isXHR = false;
	req.uri = {};
	req.ip = '';
	req.flags = [];
	req.session = {};
	req.prefix = '';
	req.subdomain = [];
	res.isFlush = false;

	var header = req.headers;
	var protocol = req.connection.encrypted ? 'https' : 'http';

   	req.host = header['host'];
   	req.uri = urlParser.parse(protocol + '://' + req.host + req.url);

	var subdomain = req.uri.host.toLowerCase().split('.');
	
	if (subdomain.length > 2)
		req.subdomain = subdomain.slice(0, subdomain.length - 2); // example: [subdomain].domain.com

	var proxy = header['x-forwarded-for'];

	//  x-forwarded-for: client, proxy1, proxy2, ...
	if (typeof(proxy) !== 'undefined')
		req.ip = proxy.split(',', 1)[0] || req.connection.remoteAddress;
	else
		req.ip = req.connection.remoteAddress;

   	if (req.uri.query)
   		req.data.get = qs.parse(req.uri.query);

   	// if static file, return
   	if (utils.isStaticFile(req.uri.pathname)) {
   		
	    req.on('end', function () {
	    	var files = self.routesFile;
			if (files.length > 0) {
				for (var i = 0; i < files.length; i++) {
					var file = files[i];
					try
					{
						if (file.onValidation.call(self, req, res)) {
							file.onExecute.call(self, req, res);
							return;
						}
					} catch (err) {
						self.error(err, file.controller + ' :: ' + file.name, req.uri);
					}
				}
			}
			self.onStatic(req, res);
	   	});

		req.resume();
	   	return;
	}

	if (self.onRoute !== null) {
		try
		{				
			if (!self.onRoute(req, res)) {
				
				if (!res.isFlush)
					req.connection.destroy();

				return;
			}
		} catch(err) {
			self.app.error(err, 'Framework :: onRoute', req.uri);
		}
	}

	var flags = [req.method.toLowerCase()];
    var multipart = req.headers['content-type'] || '';

    if (multipart.indexOf('multipart/form-data') === -1)
    	multipart = '';

	flags.push(protocol);

	if (self.config.debug)
		flags.push('debug');

	req.isXHR = header['x-requested-with'] === 'XMLHttpRequest';
	req.prefix = self.onPrefix === null ? '' : self.onPrefix(req) || '';

	if (req.prefix.length > 0)
		flags.push('#' + req.prefix);

	if (multipart.length > 0)
		flags.push('upload');

	if (req.isXHR)
		flags.push('xhr');

	req.flags = flags;

	// call event request
	self.emit('request', req, res);

   	if (req.method === 'POST' || req.method === 'PUT') {

   		var route;

   		if (multipart.length > 0) {

   			// kontrola či Controller obsahuje flag Upload
			route = self.routeSync(req.subdomain, req.uri.pathname, req.flags, true);

   			if (route === null) {
	    		req.connection.destroy();
        		return;
   			}

				internal.parseMULTIPART(req, multipart, route.maximumSize, self.config['directory-temp'], function() {
				self.request(req, res, req.flags);
				});
				
			req.resume();
			return;

   		} else {

   			route = self.routeSync(req.subdomain, req.uri.pathname, req.flags, true);

   			if (route === null) {
    			req.connection.destroy();
				return;
   			}

   			// get data from Request BODY, get POST data
				internal.parsePOST(req, route.maximumSize);
   		}
   	};

    req.on('end', function() {

    	if (!req.buffer.isExceeded && typeof(req.buffer.data) !== 'undefined' && req.buffer.data.length > 0) {
    		var data = req.buffer.data;
    		if (route.flags.indexOf('json') !== -1) {
    			try
    			{
    				req.data.post = data.isJSON() ? JSON.parse(data) : null;
    			} catch (err) {
    				self.error(err, 'Framework :: parse POST data', req.uri);
    			}
    		} else
				req.data.post = qs.parse(data);
    	}

    	self.request(req, res, flags);
    });

	req.resume();
};

// Alias for framework.init
Framework.prototype.run = function(http, config, port) {
	return this.init(http, config, port);
};

/*
	Test request to controller
	
	@url {String}
	@callback {Functions} :: function(error, data, statusCode, headers);
	@method {String} :: default GET
	@data {String} :: default empty string
	@headers {Object} :: optional
	@xhr {Boolean} :: optional

	return {Framework}
*/
Framework.prototype.assert = function(name, url, callback, method, data, headers, xhr) {
	
	var self = this;

	if (typeof(headers) === 'boolean') {
		xhr = headers;
		headers = {};
	}

	var obj = {
		url: url,
		callback: callback,
		method: method || 'GET',
		data: data,
		headers: headers || {}
	};

	if (xhr)
		obj.headers['X-Requested-With'] = 'XMLHttpRequest';
	
	obj.headers['assertion-testing'] = '1';
	self.tests[name] = obj;

	return self;
};

/*
	Internal test function for assertion testing
	
	@stop {Boolean} :: stop framework (default true)
	@callback {Functions} :: on complete test handler

	return {Framework}
*/
Framework.prototype.testing = function(stop, callback) {

	if (typeof(stop) === 'undefined')
		stop = true;

	var self = this;
	var keys = Object.keys(self.tests);

	if (keys.length === 0) {

		if (callback)
			callback();

		if (stop)
			self.stop();

		return self;
	};

	var key = keys[0];
	var test = self.tests[key];

	delete self.tests[key];

	var cb = function(error, data, code, headers) {
		try
		{
			test.callback.call(self, error, data, key, code, headers);
		} catch (ex) {
			
			setTimeout(function() {
				self.stop();
			}, 500);

			throw ex;
		}
		self.testing(stop, callback);
	};

	var url = (test.url.indexOf('http://') > 0 || test.url.indexOf('https://') > 0 ? '' : 'http://127.0.0.1:' + self.port) + test.url;
	utils.request(url, test.method, test.data, cb, test.headers);

	return self;
};

/*
	Make a tests
	@stop {Boolean} :: stop framework (default true)
	@names {String array} :: only tests in names (optional)
	@callback {Functions} :: on complete test handler (optional)
	return {Framework}
*/
Framework.prototype.test = function(stop, names, cb) {
	
	var self = this;

	if (typeof(names) === 'function') {
		cb = names;
		names = [];
	} else
		names = names || [];

	fs.readdirSync('.' + self.config['directory-tests']).forEach(function(name) {

		var fileName = path.join(directory, self.config['directory-tests'], name);

		if (path.extname(fileName).toLowerCase() !== '.js')
			return;

		if (names.length > 0 && names.indexOf(name.substring(0, name.length - 3)) === -1)
			return;

		var test = require(fileName);

		try
		{
			var isRun = typeof(test.run) !== 'undefined';
			var isInit = typeof(test.init) !== 'undefined';
			var isLoad = typeof(test.load) !== 'undefined';

			if (isRun)
				test.run(self, name);
			else if (isInit)
				test.init(self, name);
			else if (isLoad)
				test.load(self, name);

		} catch (ex) {
			self.cache.stop();
			self.server.close();
			throw ex;
		}
	});

	self.testing(stop, cb);
	return self;
};

/*
	Clear temporary directory
	return {Framework}
*/
Framework.prototype.clear = function() {

	var self = this;
	var dir = utils.combine(self.config['directory-temp']);

	if (!fs.existsSync(dir))
		return self;

	fs.readdir(dir, function(err, files) {
		
		if (err)
			return;

		files.forEach(function(file) {
			var fileName = utils.combine(self.config['directory-temp'], file);
			fs.unlink(fileName);
    	});
	});

	// clear static cache
	self.static = {};
	return self;
};

/*
	Cryptography (encode)
	@value {String}
	@key {String}
	@isUniqe {Boolean} :: optional
	return {Framework}
*/
Framework.prototype.encode = function(value, key, isUnique) {

	var self = this;
	var type = typeof(value);
	
	if (type === 'undefined')
		return '';

	if (type === 'function')
		value = value();

	if (type === 'number')
		value = value.toString();

	if (type === 'object')
		value = JSON.stringify(value);

	return value.encode(self.config.secret + '=' + key, isUnique || true);
};

/*
	Cryptography (decode)
	@value {String}
	@key {String}
	@jsonConvert {Boolean} :: optional (convert string to JSON)
	return {String or Object};
*/
Framework.prototype.decode = function(value, key, jsonConvert) {

	jsonConvert = jsonConvert || true;

	var self = this;
	var result = (value || '').decode(self.config.secret + '=' + key);

	if (jsonConvert && result.isJSON())
		return JSON.parse(result);

	return result;
};

/*
	Resource reader
	@name {String} :: filename of resource
	@key {String}
	return {String};
*/
Framework.prototype.resource = function(name, key) {

	if (typeof(key) === 'undefined' || name.length === 0) {
		key = name;
		name = 'default';
	}

	var self = this;
	var res = self.resources[name];

	if (typeof(res) !== 'undefined')
		return res[key];

	var fileName = utils.combine(self.config['directory-resources'], name + '.resource');
	var obj = {};
	
	if (!fs.existsSync(fileName))
		return '';

	var arr = fs.readFileSync(fileName).toString(encoding).split('\n');
	for (var i = 0; i < arr.length; i++) {
		var str = arr[i];

		if (str === '')
			continue;

		var index = str.indexOf(':');
		if (index === -1)
			continue;

		obj[str.substring(0, index).trim()] = str.substring(index + 1).trim();
	}

	self.resources[name] = obj;	
	return obj[key] || '';
};

/*
	Configuration from file
	return {Framework}
*/
Framework.prototype.configure = function() {
	
	var self = this;
	var fileName = utils.combine('/', 'config-' + (self.config.debug ? 'debug' : 'release'));

	if (!fs.existsSync(fileName))
		return self;

	var obj = {};
	var arr = fs.readFileSync(fileName).toString(encoding).split('\n');
	var accepts = null;

	for (var i = 0; i < arr.length; i++) {
		var str = arr[i];

		if (str === '')
			continue;

		var index = str.indexOf(':');
		if (index === -1)
			continue;

		var name = str.substring(0, index).trim();

		if (name === 'debug' || name === 'resources')
			continue; 

		var value = str.substring(index + 1).trim();

		switch (name) {
			case 'default-request-length':
				obj[name] = utils.parseInt(value);
				break;
			case 'static-accepts-custom':
				accepts = value.replace(/\s/g, '').split(',');
				break;
			case 'static-accepts':
				obj[name] = value.replace(/\s/g, '').split(',');
				break;
			default:
				obj[name] = value.isNumber() ? utils.parseInt(value) : value.isNumber(true) ? utils.parseFloat(value) : value;
				break;
		}		
	}

	utils.extend(self.config, obj, true);
	process.title = self.config.name;

	if (accepts !== null && accepts.length > 0) {
		accepts.forEach(function(accept) {
			if (self.config['static-accepts'].indexOf(accept) === -1)
				self.config.config['static-accepts'].push(accept);
		});
	}
	
	return self;
};

Framework.prototype.verification = function(cb) {

	var self = this;

	if (typeof(self.verify) === 'undefined') {
		self.configure();
		self.verify = null;
	}

	if (self.verify !== null) {

		if (self.verify.length > 0) {
			var test = self.verify.shift();
			test();
			return;
		}

		if (self.verify.length === 0) {
			self.verify = null;
			cb.call(this, self.verifyError);
			return;
		}

		return;
	}

	self.verify = [];
	self.verifyError = [];
	
	self.verify.push(function verifyVersion() {
		utils.request('https://raw.github.com/petersirka/partial.js/master/package.json', 'GET', '', function(err, data) {
			
			if (!err) {
				var obj = JSON.parse(data);
				var git = utils.parseInt(obj.version.replace(/[\.\-]/g, ''));
				var gitFrom = utils.parseInt(obj.versionDifference.replace(/[\.\-]/g, ''));
				if (self.version < git)
					self.verifyError.push('FrameworkVersion: partial.js has a new version v' + git + (self.version >= gitFrom ? ' (trouble-free installation)' : ' (many changes in code)'));
			}

			self.verification.call(self, cb);
		});
	});

	self.verify.push(function verifyDirectory() {

		if (!fs.existsSync('.' + self.config['directory-controllers']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-controllers']);

		if (!fs.existsSync('.' + self.config['directory-views']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-views']);

		if (!fs.existsSync('.' + self.config['directory-contents']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-contents']);

		if (!fs.existsSync('.' + self.config['directory-temp']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-temp']);

		if (!fs.existsSync('.' + self.config['directory-templates']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-templates']);

		if (!fs.existsSync('.' + self.config['directory-resources']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-resources']);

		if (!fs.existsSync('.' + self.config['directory-public']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-public']);

		if (!fs.existsSync('.' + self.config['directory-modules']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-modules']);

		if (!fs.existsSync('.' + self.config['directory-databases']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-databases']);

		if (!fs.existsSync('.' + self.config['directory-logs']))
			self.verifyError.push('DirectoryNotFound: ' + self.config['directory-logs']);

		self.verification.call(self, cb);
	});

	self.verify.push(function verifyGraphicsMagick() {
		var exec = require('child_process').exec;

		exec('gm', function(error, stdout, stderr) {

			if (stderr.length !== 0)
				self.verifyError.push('GraphicsMagickError: ' + stderr);

			self.verification.call(self, cb);
		});
	});

	self.verify.push(function verifyGraphicsMagick() {
		var exec = require('child_process').exec;

		exec('convert', function(error, stdout, stderr) {

			if (stderr.length !== 0)
				self.verifyError.push('ImageMagickError: ' + stderr);

			self.verification.call(self, cb);
		});
	});

	self.verification.call(self, cb);
};

/*
	Static file routing
	@name {String} :: filename
	return {String};
*/
Framework.prototype.routeJS = function(name) {
	var self = this;

	if (name.indexOf('.js') === -1)
		name += '.js';

	return self.routeStaticSync(name, self.config['static-url-js']);
};

/*
	Static file routing
	@name {String} :: filename
	return {String};
*/
Framework.prototype.routeCSS = function(name) {
	var self = this;

	if (name.indexOf('.css') === -1)
		name += '.css';

	return self.routeStaticSync(name, self.config['static-url-css']);
};

/*
	Static file routing
	@name {String} :: filename
	return {String};
*/
Framework.prototype.routeImage = function(name) {
	var self = this;
	return self.routeStaticSync(name, self.config['static-url-image']);
};

/*
	Static file routing
	@name {String} :: filename
	return {String};
*/
Framework.prototype.routeVideo = function(name) {
	var self = this;
	return self.routeStaticSync(name, self.config['static-url-video']);
};

/*
	Static file routing
	@name {String} :: filename
	return {String};
*/
Framework.prototype.routeFont = function(name) {
	var self = this;
	return self.routeStaticSync(name, self.config['static-url-font']);
};

/*
	Static file routing
	@name {String} :: filename
	return {String};
*/
Framework.prototype.routeDocument = function(name) {
	var self = this;
	return self.routeStaticSync(name, self.config['static-url-document']);
};

/*
	Static file routing
	@name {String} :: filename
	return {String};
*/
Framework.prototype.routeStatic = function(name) {
	var self = this;
	return self.routeStaticSync(name, self.config['static-url']);
};

/*
	Internal sync route function
	@subdomain {String array}
	@pathname {String}
	@flags {String array}
	@noLoggedUnlogged {Boolean}
	return {Boolean};
*/
Framework.prototype.routeSync = function(subdomain, pathname, flags, noLoggedUnlogged) {
	
	var self = this;
	var url = internal.routeSplit(pathname);
	var isSystem = pathname[0] === '#';

	return self.routes.find(function(obj) {

		if (!internal.routeCompareSubdomain(subdomain, obj.subdomain))
			return false;

		if (!internal.routeCompare(url, obj.url, isSystem))
			return false;

		if (internal.routeCompareFlags(flags, obj.flags, noLoggedUnlogged) < 1)
			return false;

		return true;
	});
};

/*
	Internal static file routing
	@name {String} :: filename
	@directory {String} :: directory
	return {String};
*/
Framework.prototype.routeStaticSync = function(name, directory) {
	var self = this;
	var fileName = self.onVersion === null ? name : self.onVersion(name) || name;
	return directory + fileName;
};

/*
	Per Request handler (internal function, this function create subscribe object and subscribe call controller)
	@req {ServerRequest}
	@res {ServerResponse}
	@flags {String array}
	return {Framework}
*/
Framework.prototype.request = function(req, res, flags) {
	
	var self = this;

	if (self.onAuthorization === null) {
		subscribe.init(self, req, res).lookup(req.subdomain, req.buffer.isExceeded ? '#431' : req.uri.pathname, flags);
		return self;
	}

	self.onAuthorization(req, res, flags, function (isLogged) {
		flags.push(isLogged ? 'logged' : 'unlogged');
		subscribe.init(self, req, res).lookup(req.subdomain, req.buffer.isExceeded ? '#431' : req.uri.pathname, flags);
	});

	return self;
};

module.exports = new Framework();