﻿(function () {
    'use strict';

    TLRGRP.namespace('TLRGRP.BADGER.Dashboard.DataStores');

    var defaultOptions = {
        pauseWhenNotVisible: true,
        components: {},
        refresh: 10000
    };

    var currentTimeFrame = {
        timeFrame: 1,
        units: 'hours'
    };

    TLRGRP.messageBus.subscribe('TLRGRP.BADGER.TimePeriod.Set', function(timeFrameData) {
        currentTimeFrame = timeFrameData;
    });

    function getValueFromSubProperty(value, property) {
        var valuePropertySegments = property.split('.');
        var segmentEscaper = /\|/ig;

        _.each(valuePropertySegments, function(segment) {
            value = value[segment.replace(segmentEscaper, ".")];
        });

        return value;
    }

    function extractFromDateHistogram(config, aggregate, name) {
        var dates = aggregate.buckets;

        return _.map(dates, function(dateBucket) {
            var parsedObject = {
                time: moment(dateBucket.to_as_string || dateBucket.key).toDate()
            };

            parsedObject[name] = _.reduce(config.fields, function(memo, field, key) {
                memo[key] = getValueFromSubProperty(dateBucket, field)
                return memo;
            }, {});

            return parsedObject;
        });
    }

    TLRGRP.BADGER.Dashboard.DataStores.SyncAjaxDataStore = function (options) {
        var currentOptions = $.extend(true, {}, defaultOptions, options);
        var currentTimeout;
        var defaultAjaxOptions = {
            type: 'GET'
        };
        var stateMachine = nano.Machine({
            states: {
                stopped: {
                    _onEnter: function () {
                        clearCurrentTimeout();
                    },
                    start: function (doItNow) {
                        if (doItNow) {
                            this.transitionToState('refreshing');
                            return;
                        }
                        this.transitionToState('waiting');
                    },
                    refreshComplete: function (data) {
                        if(currentOptions.request && currentOptions.request.responseMapper) {
                            data = currentOptions.request.responseMapper(data);
                        }
                        executeSuccessCallbackIfSpecified(data);
                    },
                    refreshFailed: function (errorInfo) {
                        executeErrorCallbackIfSpecified(errorInfo);
                    }
                },
                waiting: {
                    _onEnter: function () {
                        var stateMachineApi = this;

                        currentTimeout = setTimeout(function () {
                            stateMachineApi.transitionToState('refreshing');
                        }, currentOptions.refresh);
                    },
                    start: function (doItNow) {
                        var stateMachineApi = this;

                        if (doItNow) {
                            clearTimeout(currentTimeout);
                            this.transitionToState('refreshing');
                            return;
                        }

                        currentTimeout = setTimeout(function () {
                            stateMachineApi.transitionToState('refreshing');
                        }, currentOptions.refresh);
                    },
                    stop: function () {
                        this.transitionToState('stopped');
                    }
                },
                refreshing: {
                    _onEnter: function () {
                        if (currentOptions.components.loading) {
                            currentOptions.components.loading.loading();
                        }

                        var queries = currentOptions.request.requestBuilder({
                            timeFrame: currentTimeFrame
                        });

                        var responses = {};
                        var deferreds = _.map(queries, function(queryOptions) {
                            var ajaxOptions = {
                                url: currentOptions.url,
                                data: currentOptions.data,
                                success: function(data) {
                                    responses[queryOptions.id] = data;
                                }
                            };

                            if(currentOptions.request && currentOptions.request.requestBuilder) {
                                ajaxOptions = $.extend(ajaxOptions, queryOptions);
                            }

                            if (currentOptions.type) {
                                ajaxOptions.type = currentOptions.type;
                            }

                            if (currentOptions.contentType) {
                                ajaxOptions.contentType = currentOptions.contentType;
                            }

                            return $.ajax($.extend(true, {}, defaultAjaxOptions, ajaxOptions));
                        });

                        var calculations = {
                            'percentage': function(by, property) {
                                return (property[by.field] / parseFloat(property[by.over])) * 100;
                            }
                        };

                        var mappers = {
                            'extractFromDateHistogram': function(mapping, data) {
                                if(data.aggregations) {
                                    return extractFromDateHistogram(mapping, data.aggregations[mapping.aggregateName]);
                                }

                                return _.reduce(data, function(memo, response, key) {
                                    var processedBucket = extractFromDateHistogram(mapping, response.aggregations[mapping.aggregateName], key);

                                    if(!memo.length) {
                                        return processedBucket;
                                    }

                                    var memoLength = memo.length;
                                    var x = 0;

                                    for(; x < memoLength; x++) {
                                        memo[x][key] = processedBucket[x][key];
                                    }

                                    return memo;
                                }, []);
                            },
                            'calculation': function(mapping, data) {
                                if(!calculations[mapping.calculation]) {
                                    return; 
                                }

                                _.each(data, function(dateBucket) {
                                    _.each(dateBucket, function(property, key) {
                                        if(key === 'time') {
                                            return;
                                        }

                                        property[mapping.toField] = calculations[mapping.calculation](mapping.by, property);
                                    });
                                });
                                return data;
                            },
                            'stats': function(mapping, data) {
                                function average(a) {
                                    var r = {mean: 0, variance: 0, deviation: 0}, t = a.length;
                                    for(var m, s = 0, l = t; l--; s += a[l]);
                                    for(m = r.mean = s / t, l = t, s = 0; l--; s += Math.pow(a[l] - m, 2));
                                    return r.deviation = Math.sqrt(r.variance = s / t), r;
                                }

                                _.each(data, function(dateBucket) {
                                    var values = _.map(mapping.fields, function(field) {
                                        if(isNaN(dateBucket[field][mapping.property]) || dateBucket[field][mapping.property] == Number.POSITIVE_INFINITY) return;

                                        return dateBucket[field][mapping.property];
                                    });
                                    var stats = average(values);

                                    dateBucket[mapping.toField || 'value'] = stats;
                                });

                                return data;
                            }
                        };

                        $.when.apply(undefined, deferreds)
                            .fail(function() {
                                stateMachine.handle('refreshFailed');
                            })
                            .then(function() {
                                var data = responses;

                                _.each(options.mappings, function(mapping) {
                                    if(!mappers[mapping.type]) {
                                        return;
                                    }
                                    data = mappers[mapping.type](mapping, data);
                                });

                                _.each(data, function(entry) {
                                    var calculations = entry.value;

                                    entry.value.today = entry.today.commission;
                                    entry.value.plusOneStd = calculations.mean + calculations.deviation;
                                    entry.value.minusOneStd = calculations.mean - calculations.deviation;
                                    entry.value.plusTwoStd = calculations.mean + (calculations.deviation * 2);
                                    entry.value.minusTwoStd = calculations.mean - (calculations.deviation * 2);
                                });                     

                                stateMachine.handle('refreshComplete', data);
                            });
                    },
                    refreshComplete: function (data) {
                        executeSuccessCallbackIfSpecified(data);
                        
                        if (currentOptions.components.loading) {
                            currentOptions.components.loading.finished();
                        }

                        this.transitionToState('waiting');
                    },
                    refreshFailed: function (errorInfo) {
                        executeErrorCallbackIfSpecified(errorInfo);

                        if (currentOptions.components.loading) {
                            currentOptions.components.loading.finished();
                        }

                        this.transitionToState('waiting');
                    },
                    stop: function () {
                        this.transitionToState('stopped');
                    }
                }
            },
            initialState: 'stopped'
        });

        function clearCurrentTimeout() {
            if (currentTimeout) {
                clearTimeout(currentTimeout);
            }
        }

        function executeSuccessCallbackIfSpecified(data) {
            if (currentOptions.callbacks.success && $.isFunction(currentOptions.callbacks.success)) {
                currentOptions.callbacks.success(data);
            }
            
            if (currentOptions.components.lastUpdated) {
                currentOptions.components.lastUpdated.setLastUpdated(data.refreshedAt);
            }
        }

        function executeErrorCallbackIfSpecified(errorInfo) {
            if (currentOptions.callbacks.error && $.isFunction(currentOptions.callbacks.error)) {
                currentOptions.callbacks.error(errorInfo);
            }

            if (currentOptions.components.lastUpdated) {
                currentOptions.components.lastUpdated.refreshText();
            }
        }

        function setNewRefresh(refreshIn) {
            currentOptions.refresh = refreshIn;
        }

        if (currentOptions.pauseWhenNotVisible) {
            TLRGRP.messageBus.subscribe('TLRGRP.BADGER.PAGE.Hidden', function () {
                stateMachine.handle('pause');
            });

            TLRGRP.messageBus.subscribe('TLRGRP.BADGER.PAGE.Visible', function () {
                stateMachine.handle('unpause');
            });
        }

        TLRGRP.messageBus.subscribe('TLRGRP.BADGER.TimePeriod.Selected', function(timeFrameData) {
            stateMachine.handle('stop');
            
            currentTimeFrame = timeFrameData;

            stateMachine.handle('start', true);
        });

        return {
            start: function (doItNow) {
                stateMachine.handle('start', doItNow);
            },
            stop: function () {
                stateMachine.handle('stop');
            },
            setNewRefresh: function (newRefresh) {
                setNewRefresh(newRefresh);
            }
        };
    };
})();
