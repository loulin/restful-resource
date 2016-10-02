'use strict';
// https://github.com/angular/angular.js/blob/master/src/ngResource/resource.js
var util = require('util');
var _ = require('lodash');
var rp = require('request-promise');
var PROTOCOL_AND_DOMAIN_REGEX = /^https?:\/\/[^\/]*/;
var provider = {
  defaults: {
    // Strip slashes by default
    stripTrailingSlashes: true,

    // Default actions configuration
    actions: {
      get: { method: 'GET' },
      query: { method: 'GET' },
      create: { method: 'POST' },
      update: { method: 'PUT' },
      save: { method: 'POST' },
      remove: { method: 'DELETE' },
      delete: { method: 'DELETE' }
    },

    // request default options
    request: { json: true }
  }
};

function resourceMinErr(name, template, path) {
  var message = util.format(template, path);
  var error = new Error(message);
  error.name = name;
  return error;
}

function encodeUriQuery(val, pctEncodeSpaces) {
  return encodeURIComponent(val)
    .replace(/%40/gi, '@')
    .replace(/%3A/gi, ':')
    .replace(/%24/g, '$')
    .replace(/%2C/gi, ',')
    .replace(/%20/g, (pctEncodeSpaces ? '%20' : '+'));
}

function encodeUriSegment(val) {
  return encodeUriQuery(val, true)
    .replace(/%26/gi, '&')
    .replace(/%3D/gi, '=')
    .replace(/%2B/gi, '+')
    .replace(/%2F/gi, '/');
}

/**
 * Create a shallow copy of an object and clear other fields from the destination
 */
function shallowClearAndCopy(src, _dst) {
  var dst = _dst || {};

  _.forEach(dst, function (value, key) {
    delete dst[key];
  });

  _.forOwn(src, function (value, key) {
    if (!(key.charAt(0) === '$' && key.charAt(1) === '$')) {
      dst[key] = src[key];
    }
  });

  return dst;
}

function Route(template, defaults) {
  this.template = template;
  this.defaults = _.assign({}, provider.defaults, defaults);
  this.urlParams = {};
}

Route.prototype = {
  setUrlParams: function (config, _params) {
    var self = this;
    var params = _params || {};
    var url = params.url || self.template;
    var val;
    var encodedVal;
    var protocolAndDomain = '';

    var urlParams = self.urlParams = Object.create(null);


    _.forEach(url.split(/\W/), function (param) {
      if (param === 'hasOwnProperty') {
        throw resourceMinErr('BadParamName', 'hasOwnProperty is not a valid parameter name.');
      }

      if (!(new RegExp('^\\d+$').test(param)) && param &&
        (new RegExp('(^|[^\\\\]):' + param + '(\\W|$)').test(url))) {
        urlParams[param] = {
          isQueryParamValue: (new RegExp('\\?.*=:' + param + '(?:\\W|$)')).test(url)
        };
      }
    });
    url = url.replace(/\\:/g, ':');
    url = url.replace(PROTOCOL_AND_DOMAIN_REGEX, function (match) {
      protocolAndDomain = match;
      return '';
    });

    _.forEach(self.urlParams, function (paramInfo, urlParam) {
      val = _.has(params, urlParam) ? params[urlParam] : self.defaults[urlParam];
      if (!_.isNil(val)) {
        if (paramInfo.isQueryParamValue) {
          encodedVal = encodeUriQuery(val, true);
        } else {
          encodedVal = encodeUriSegment(val);
        }
        url = url.replace(new RegExp(':' + urlParam + '(\\W|$)', 'g'), function (match, p1) {
          return encodedVal + p1;
        });
      } else {
        url = url.replace(
          new RegExp('(/?):' + urlParam + '(\\W|$)', 'g'),
          function (match, leadingSlashes, tail) {
            return (tail.charAt(0) === '/') ? tail : (leadingSlashes + tail);
          }
        );
      }
    });

    // strip trailing slashes and set the url (unless this behavior is specifically disabled)
    if (self.defaults.stripTrailingSlashes) {
      url = url.replace(/\/+$/, '') || '/';
    }

    // then replace collapse `/.` if found in the last URL path segment before the query
    // E.g. `http://url.com/id./format?q=x` becomes `http://url.com/id.format?q=x`
    url = url.replace(/\/\.(?=\w+($|\?))/, '.');
    // replace escaped `/\.` with `/.`
    config.uri = protocolAndDomain + url.replace(/\/\\\./, '/.');
  }
};

function resourceFactory(url, paramDefaults, _actions, options) {
  var route = new Route(url, options);
  var actions = _.assign({}, provider.defaults.actions, _actions);

  function extractParams(data, _actionParams) {
    var ids = {};
    var actionParams = _.assign({}, paramDefaults, _actionParams);

    _.forEach(actionParams, function (_value, key) {
      var value = _value;

      if (_.isFunction(value)) value = value(data);

      ids[key] = value && value.charAt &&
        value.charAt(0) === '@' ? _.get(data, value.substr(1)) : value;
    });

    return ids;
  }

  function Resource(value) {
    shallowClearAndCopy(value || {}, this);
  }

  Resource.prototype.toJSON = function () {
    return _.assign({}, this);
  };

  _.forEach(actions, function (actionConfig, name) {
    var method = actionConfig.method && 'GET';
    var hasBody = /^(POST|PUT|PATCH)$/i.test(method);

    Resource[name] = function (_params, _data) {
      var params = _params || {};
      var data = _data;
      var isInstanceCall = this instanceof Resource;
      var instance;
      var httpConfig = {};

      if (arguments.length === 1 && hasBody) data = _params;

      instance = isInstanceCall ? data : new Resource(data);

      // actionConfig contains request options
      _.assign(httpConfig, _.omit(actionConfig, ['params']));

      if (hasBody) httpConfig.body = data;

      route.setUrlParams(
        httpConfig,
        _.assign({}, extractParams(data, actionConfig.params || {}), params)
      );

      return rp(httpConfig).then(function (result) {
        if (result) {
          if (_.isArray(result)) {
            if (result[0] && _.isPlainObject(result[0])) {
              instance = result.map(function (item) {
                return new Resource(item);
              });
            }
          } else {
            shallowClearAndCopy(result, instance);
          }

          return instance;
        }

        return result;
      });
    };

    Resource.prototype[name] = function (params) {
      return Resource[name].call(this, params, this);
    };
  });

  Resource.bind = function (additionalParamDefaults) {
    var extendedParamDefaults = _.assign({}, paramDefaults, additionalParamDefaults);
    return resourceFactory(url, extendedParamDefaults, actions, options);
  };

  return Resource;
}

resourceFactory.defaults = function (defaults) {
  _.merge(provider.defaults, defaults);
  rp = rp.defaults(provider.defaults.request);
};

module.exports = resourceFactory;
