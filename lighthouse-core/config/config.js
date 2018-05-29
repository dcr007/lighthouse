/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const defaultConfigPath = './default-config.js';
/** @type {LH.Config.Json} */ // TODO(bckenny): why is this declaration necessary?
const defaultConfig = require('./default-config.js');
const fullConfig = require('./full-config.js');
const constants = require('./constants');

const isDeepEqual = require('lodash.isequal');
const log = require('lighthouse-logger');
const path = require('path');
const Audit = require('../audits/audit');
const Runner = require('../runner');

/** @typedef {import('../gather/gatherers/gatherer.js')} Gatherer */

// TODO(bckenny): embrace the nulls instead of undefined
// TODO(bckenny): how to start moving types from externs to Config class?
// TODO(bckenny): make LH.Config a valid LH.Config.Json
// TODO(bckenny): add test for round trip json -> Config -> back into Config (and unchanged)
// TODO(bckenny): test above including extends and only() to make sure they're indompetent

/**
 * @param {LH.Config['passes']} passes
 * @param {LH.Config['audits']} audits
 */
function validatePasses(passes, audits) {
  if (!Array.isArray(passes)) {
    return;
  }
  
  const requiredGatherers = Config.getGatherersNeededByAudits(audits);

  // Log if we are running gathers that are not needed by the audits listed in the config
  passes.forEach(pass => {
    pass.gatherers.forEach(gathererDefn => {
      const gatherer = gathererDefn.instance;
      const isGatherRequiredByAudits = requiredGatherers.has(gatherer.name);
      if (!isGatherRequiredByAudits) {
        const msg = `${gatherer.name} gatherer requested, however no audit requires it.`;
        log.warn('config', msg);
      }
    });
  });

  // Passes must have unique `passName`s. Throw otherwise.
  const usedNames = new Set();
  passes.forEach(pass => {
    const passName = pass.passName;
    if (usedNames.has(passName)) {
      throw new Error(`Passes must have unique names (repeated passName: ${passName}.`);
    }
    usedNames.add(passName);
  });
}

/**
 * @param {LH.Config['categories']} categories
 * @param {LH.Config['audits']} audits
 * @param {LH.Config['groups']} groups
 */
function validateCategories(categories, audits, groups) {
  if (!categories) {
    return;
  }

  Object.keys(categories).forEach(categoryId => {
    categories[categoryId].auditRefs.forEach((auditRef, index) => {
      if (!auditRef.id) {
        throw new Error(`missing an audit id at ${categoryId}[${index}]`);
      }

      const audit = audits && audits.find(a => a.implementation.meta.name === auditRef.id);
      if (!audit) {
        throw new Error(`could not find ${auditRef.id} audit for category ${categoryId}`);
      }

      const auditImpl = audit.implementation;
      const isManual = auditImpl.meta.scoreDisplayMode === 'manual';
      if (categoryId === 'accessibility' && !auditRef.group && !isManual) {
        throw new Error(`${auditRef.id} accessibility audit does not have a group`);
      }

      if (auditRef.weight > 0 && isManual) {
        throw new Error(`${auditRef.id} is manual but has a positive weight`);
      }

      if (auditRef.group && (!groups || !groups[auditRef.group])) {
        throw new Error(`${auditRef.id} references unknown group ${auditRef.group}`);
      }
    });
  });
}

/**
 * @param {typeof Audit} auditDefinition
 * @param {string=} auditPath
 */
function assertValidAudit(auditDefinition, auditPath) {
  const auditName = auditPath ||
    (auditDefinition && auditDefinition.meta && auditDefinition.meta.name);

  if (typeof auditDefinition.audit !== 'function' || auditDefinition.audit === Audit.audit) {
    throw new Error(`${auditName} has no audit() method.`);
  }

  if (typeof auditDefinition.meta.name !== 'string') {
    throw new Error(`${auditName} has no meta.name property, or the property is not a string.`);
  }

  if (typeof auditDefinition.meta.description !== 'string') {
    throw new Error(
      `${auditName} has no meta.description property, or the property is not a string.`
    );
  }

  // If it'll have a ✔ or ✖ displayed alongside the result, it should have failureDescription
  if (typeof auditDefinition.meta.failureDescription !== 'string' &&
    auditDefinition.meta.scoreDisplayMode === Audit.SCORING_MODES.BINARY) {
    throw new Error(`${auditName} has no failureDescription and should.`);
  }

  if (typeof auditDefinition.meta.helpText !== 'string') {
    throw new Error(
      `${auditName} has no meta.helpText property, or the property is not a string.`
    );
  } else if (auditDefinition.meta.helpText === '') {
    throw new Error(
      `${auditName} has an empty meta.helpText string. Please add a description for the UI.`
    );
  }

  if (!Array.isArray(auditDefinition.meta.requiredArtifacts)) {
    throw new Error(
      `${auditName} has no meta.requiredArtifacts property, or the property is not an array.`
    );
  }
}

/**
 * @param {Gatherer} gathererInstance
 * @param {string=} gathererName
 */
function assertValidGatherer(gathererInstance, gathererName) {
  gathererName = gathererName || gathererInstance.name || 'gatherer';

  if (typeof gathererInstance.beforePass !== 'function') {
    throw new Error(`${gathererName} has no beforePass() method.`);
  }

  if (typeof gathererInstance.pass !== 'function') {
    throw new Error(`${gathererName} has no pass() method.`);
  }

  if (typeof gathererInstance.afterPass !== 'function') {
    throw new Error(`${gathererName} has no afterPass() method.`);
  }
}

// TODO(bckenny): make Flags partial by default?
/**
 * Creates a settings object from potential flags object by dropping all the properties
 * that don't exist on Config.Settings.
 * @param {Partial<LH.Flags>=} flags
 * @return {Partial<LH.Config.Settings>}
 */
function cleanFlagsForSettings(flags = {}) {
  const settings = {};
  /** @type {Array<keyof LH.SharedFlagsSettings>} */
  const keys = Object.keys(flags);
  for (const key of keys) {
    if (typeof constants.defaultSettings[key] !== 'undefined') {
      settings[key] = flags[key];
    }
  }

  return settings;
}

// TODO(phulce): disentangle this merge function
// TODO(bckenny): type in externs? T and U extends below, returns T & U?
/**
 * @param {Object<string, any>|Array<any>|undefined|null} base
 * @param {Object<string, any>|Array<any>} extension
 * @param {boolean=} overwriteArrays
 */
function merge(base, extension, overwriteArrays = false) {
  // If the default value doesn't exist or is explicitly null, defer to the extending value
  if (typeof base === 'undefined' || base === null) {
    return extension;
  } else if (typeof extension === 'undefined') {
    return base;
  } else if (Array.isArray(extension)) {
    if (overwriteArrays) return extension;
    if (!Array.isArray(base)) throw new TypeError(`Expected array but got ${typeof base}`);
    const merged = base.slice();
    extension.forEach(item => {
      if (!merged.some(candidate => isDeepEqual(candidate, item))) merged.push(item);
    });

    return merged;
  } else if (typeof extension === 'object') {
    if (typeof base !== 'object') throw new TypeError(`Expected object but got ${typeof base}`);
    if (Array.isArray(base)) throw new TypeError('Expected object but got Array');
    Object.keys(extension).forEach(key => {
      const localOverwriteArrays = overwriteArrays ||
        (key === 'settings' && typeof base[key] === 'object');
      base[key] = merge(base[key], extension[key], localOverwriteArrays);
    });
    return base;
  }

  return extension;
}

/**
 * @template T
 * @param {Array<T>} array
 * @return {Array<T>}
 */
function cloneArrayWithPluginSafety(array) {
  return array.map(item => {
    return typeof item === 'object' ? Object.assign({}, item) : item;
  });
}

/**
 * // TODO(bckenny): could adopt "jsonified" type to ensure T is jsonifiable: https://github.com/Microsoft/TypeScript/issues/21838
 * @template T
 * @param {T} json
 * @return {T}
 */
function deepClone(json) {
  return JSON.parse(JSON.stringify(json));
}

/**
 * Deep clone a ConfigJson, copying over any "live" gatherer or audit that
 * wouldn't make the JSON round trip.
 * @param {LH.Config.Json} json
 * @return {LH.Config.Json}
 */
function deepCloneConfigJson(json) {
  const cloned = deepClone(json);

  // Copy arrays that could contain plugins to allow for programmatic
  // injection of plugins.
  if (Array.isArray(cloned.passes) && Array.isArray(json.passes)) {
    for (let i = 0; i < cloned.passes.length; i++) {
      const pass = cloned.passes[i];
      pass.gatherers = cloneArrayWithPluginSafety(json.passes[i].gatherers || []);
    }
  }

  if (Array.isArray(json.audits)) {
    cloned.audits = cloneArrayWithPluginSafety(json.audits);
  }

  return cloned;
}

class Config {
  /**
   * @constructor
   * @param {LH.Config.Json=} configJSON
   * @param {LH.Flags=} flags
   */
  constructor(configJSON, flags) {
    let configPath = flags && flags.configPath;

    if (!configJSON) {
      configJSON = defaultConfig;
      configPath = path.resolve(__dirname, defaultConfigPath);
    }

    if (configPath && !path.isAbsolute(configPath)) {
      throw new Error('configPath must be an absolute path.');
    }

    // We don't want to mutate the original config object
    configJSON = deepCloneConfigJson(configJSON);

    // Extend the default or full config if specified
    if (configJSON.extends === 'lighthouse:full') {
      const explodedFullConfig = Config.extendConfigJSON(deepCloneConfigJson(defaultConfig),
          deepCloneConfigJson(fullConfig));
      configJSON = Config.extendConfigJSON(explodedFullConfig, configJSON);
    } else if (configJSON.extends) {
      configJSON = Config.extendConfigJSON(deepCloneConfigJson(defaultConfig), configJSON);
    }

    const settings = Config.initSettings(configJSON.settings, flags);

    // Augment passes with necessary defaults
    const passesWithDefaults = Config.augmentPassesWithDefaults(configJSON.passes);
    Config.adjustDefaultPassForThrottling(settings, passesWithDefaults);

    // Expand audit/gatherer short-hand representations and merge in defaults
    // combine with require stages down there?
    const auditsWithOptions = Config.expandAuditShorthandAndMergeOptions(configJSON.audits);
    // TODO(bckenny): is this actually LH.Config.Pass yet? **NO**, gathererDefn not right yet
    const passesWithGOptions = Config.expandGathererShorthandAndMergeOptions(passesWithDefaults);

    // The directory of the config path, if one was provided.
    const configDir = configPath ? path.dirname(configPath) : undefined;

    let passes = Config.requireGatherers(passesWithGOptions, configDir);
    let audits = Config.requireAudits(auditsWithOptions, configDir);

    // TODO(bckenny): Are these directly assignable from the json?
    /** @type {?Record<string, LH.Config.Category>} */
    let categories = configJSON.categories || null;
    /** @type {?Record<string, LH.Config.Group>} */
    const groups = configJSON.groups || null;

    this._configDir = configDir;
    this._settings = settings;
    this._passes = passes;
    this._audits = audits;
    this._categories = categories;
    this._groups = groups;

    Config.filterConfigIfNeeded(this);

    validatePasses(this._passes, this._audits);
    validateCategories(this._categories, this._audits, this._groups);
  }

  /**
   * @param {LH.Config.Json} baseJSON The JSON of the configuration to extend
   * @param {LH.Config.Json} extendJSON The JSON of the extensions
   * @return {LH.Config.Json}
   */
  static extendConfigJSON(baseJSON, extendJSON) {
    if (extendJSON.passes && baseJSON.passes) {
      for (const pass of extendJSON.passes) {
        // use the default pass name if one is not specified
        const passName = pass.passName || constants.defaultPassConfig.passName;
        const basePass = baseJSON.passes.find(candidate => candidate.passName === passName);

        if (!basePass) {
          baseJSON.passes.push(pass);
        } else {
          merge(basePass, pass);
        }
      }

      delete extendJSON.passes;
    }

    return merge(baseJSON, extendJSON);
  }

  /**
   * @param {LH.Config.Json['passes']} passes
   * @return {?Array<Required<LH.Config.PassJson>>}
   */
  static augmentPassesWithDefaults(passes) {
    if (!passes) {
      return null;
    }

    const {defaultPassConfig} = constants;
    // TODO(bckenny): should be fixed with merge typing
    return passes.map(pass => merge(deepClone(defaultPassConfig), pass));
  }

  /**
   * @param {LH.Config.SettingsJson=} settings 
   * @param {LH.Flags=} flags
   * @return {LH.Config.Settings}
   */
  static initSettings(settings = {}, flags) {
    // Fill in missing settings with defaults
    const {defaultSettings} = constants;
    const settingWithDefaults = merge(deepClone(defaultSettings), settings, true);

    // Override any applicable settings with CLI flags
    const settingsWithFlags = merge(settingWithDefaults || {}, cleanFlagsForSettings(flags), true);

    // TODO(bckenny): type mismatch should be fixed by merge typing
    return settingsWithFlags;
  }

  /**
   * Expands the audits from user-specified to the internal audit definition format.
   *
   * @param {?Array<LH.Config.AuditJson>=} audits
   * @return {?Array<AuditWithOptions>}
   */
  static expandAuditShorthandAndMergeOptions(audits) {
    if (!audits) {
      return null;
    }

    const newAudits = audits.map(audit => {
      // TODO(bckenny): more precise conditionals
      if (typeof audit === 'string') {
        return {path: audit, options: {}};
      } else if ('implementation' in audit) {
        return audit;
      } else if ('path' in audit) {
        return audit;
      } else if ('audit' in audit && typeof audit.audit === 'function') {
        return {implementation: audit, options: {}};
      } else {
        throw new Error('Invalid Audit type ' + JSON.stringify(audit));
      }
    });

    return Config._mergeOptionsOfItems(newAudits);
  }

  /**
   * Expands the gatherers from user-specified to the internal gatherer definition format.
   *
   * Input Examples:
   *  - 'my-gatherer'
   *  - class MyGatherer extends Gatherer { }
   *  - {instance: myGathererInstance}
   *
   * @param {?Array<LH.Config.PassJson>=} passes
   * @return {?Array<LH.Config.Pass>} passes
   */
  static expandGathererShorthandAndMergeOptions(passes) {
    if (!passes) {
      return null;
    }

    passes.forEach(pass => {
      pass.gatherers = pass.gatherers.map(gatherer => {
        if (typeof gatherer === 'string') {
          return {path: gatherer, options: {}};
        } else if (typeof gatherer === 'function') {
          return {implementation: gatherer, options: {}};
        } else if (gatherer && typeof gatherer.beforePass === 'function') {
          return {instance: gatherer, options: {}};
        } else {
          return gatherer;
        }
      });

      pass.gatherers = Config._mergeOptionsOfItems(pass.gatherers);
    });

    return passes;
  }

  /**
   * @param {Array<{path?: string, options?: Object<string, any>}>} items
   * @return {Array<{path?: string, options?: Object<string, any>}>}
   */
  static _mergeOptionsOfItems(items) {
    /** @type {Array<{path?: string, options?: Object<string, any>}>} */
    const mergedItems = [];

    for (const item of items) {
      const existingItem = item.path && mergedItems.find(candidate => candidate.path === item.path);
      if (!existingItem) {
        mergedItems.push(item);
        continue;
      }

      existingItem.options = Object.assign({}, existingItem.options, item.options);
    }

    return mergedItems;
  }

  /**
   * Observed throttling methods (devtools/provided) require at least 5s of quiet for the metrics to
   * be computed. This method adjusts the quiet thresholds to the required minimums if necessary.
   * @param {LH.Config.Settings} settings
   * @param {?Array<Required<LH.Config.PassJson>>} passes
   */
  static adjustDefaultPassForThrottling(settings, passes) {
    if (!passes ||
        (settings.throttlingMethod !== 'devtools' && settings.throttlingMethod !== 'provided')) {
      return;
    }

    const defaultPass = passes.find(pass => pass.passName === 'defaultPass');
    if (!defaultPass) return;
    defaultPass;
    const overrides = constants.nonSimulatedPassConfigOverrides;
    defaultPass.pauseAfterLoadMs =
      Math.max(overrides.pauseAfterLoadMs, defaultPass.pauseAfterLoadMs);
    defaultPass.cpuQuietThresholdMs =
      Math.max(overrides.cpuQuietThresholdMs, defaultPass.cpuQuietThresholdMs);
    defaultPass.networkQuietThresholdMs =
      Math.max(overrides.networkQuietThresholdMs, defaultPass.networkQuietThresholdMs);
  }

  /**
   * Filter out any unrequested items from the config, based on requested categories or audits.
   * @param {Config} config
   */
  static filterConfigIfNeeded(config) {
    // 0. Extract filtering information, if any.
    const categoryIds = config.settings.onlyCategories;
    const auditIds = config.settings.onlyAudits;
    const skipAuditIds = config.settings.skipAudits;

    if (!categoryIds && !auditIds && !skipAuditIds) {
      return config;
    }

    // 1. Filter to just the chosen categories/audits
    const {categories, requestedAuditNames} = Config.filterCategoriesAndAudits(
      config.categories,
      categoryIds,
      auditIds,
      skipAuditIds
    );

    // 2. Resolve which audits will need to run
    const audits = config.audits && config.audits.filter(auditDefn =>
        requestedAuditNames.has(auditDefn.implementation.meta.name));

    // 3. Resolve which gatherers will need to run
    const requiredGathererIds = Config.getGatherersNeededByAudits(audits);

    // 4. Filter to only the neccessary passes
    const passes = Config.generatePassesNeededByGatherers(config.passes, requiredGathererIds);
    
    config._categories = categories;
    config._audits = audits;
    config._passes = passes;
  }

  /**
   * Filter out any unrequested categories or audits from the categories object.
   * @param {LH.Config['categories']} oldCategories
   * @param {?Array<string>} includedCategoryIds
   * @param {?Array<string>} includedAuditIds
   * @param {?Array<string>} skippedAuditIds
   * @return {{categories: LH.Config['categories'], requestedAuditNames: Set<string>}}
   */
  static filterCategoriesAndAudits(oldCategories, includedCategoryIds, includedAuditIds, skippedAuditIds) {
    if (!oldCategories) {
      return {categories: null, requestedAuditNames: new Set()};
    }

    if (includedAuditIds && skippedAuditIds) {
      throw new Error('Cannot set both skipAudits and onlyAudits');
    }

    /** @type {NonNullable<LH.Config['categories']>} */
    const categories = {};
    const filterByIncludedCategory = !!includedCategoryIds;
    const filterByIncludedAudit = !!includedAuditIds;
    const categoryIds = includedCategoryIds || [];
    const auditIds = includedAuditIds || [];
    const skipAuditIds = skippedAuditIds || [];

    // warn if the category is not found
    categoryIds.forEach(categoryId => {
      if (!oldCategories[categoryId]) {
        log.warn('config', `unrecognized category in 'onlyCategories': ${categoryId}`);
      }
    });

    // warn if the audit is not found in a category or there are overlaps
    const auditsToValidate = new Set(auditIds.concat(skipAuditIds));
    for (const auditId of auditsToValidate) {
      const foundCategory = Object.keys(oldCategories).find(categoryId => {
        const auditRefs = oldCategories[categoryId].auditRefs;
        return !!auditRefs.find(candidate => candidate.id === auditId);
      });

      if (!foundCategory) {
        const parentKeyName = skipAuditIds.includes(auditId) ? 'skipAudits' : 'onlyAudits';
        log.warn('config', `unrecognized audit in '${parentKeyName}': ${auditId}`);
      } else {
        if (auditIds.includes(auditId) && categoryIds.includes(foundCategory)) {
          log.warn('config', `${auditId} in 'onlyAudits' is already included by ` +
              `${foundCategory} in 'onlyCategories'`);
        }
      }
    }

    const includedAudits = new Set(auditIds);
    skipAuditIds.forEach(id => includedAudits.delete(id));

    Object.keys(oldCategories).forEach(categoryId => {
      const category = deepClone(oldCategories[categoryId]);

      if (filterByIncludedCategory && filterByIncludedAudit) {
        // If we're filtering to the category and audit whitelist, include the union of the two
        if (!categoryIds.includes(categoryId)) {
          category.auditRefs = category.auditRefs.filter(audit => auditIds.includes(audit.id));
        }
      } else if (filterByIncludedCategory) {
        // If we're filtering to just the category whitelist and the category is not included, skip it
        if (!categoryIds.includes(categoryId)) {
          return;
        }
      } else if (filterByIncludedAudit) {
        category.auditRefs = category.auditRefs.filter(audit => auditIds.includes(audit.id));
      }

      // always filter to the audit blacklist
      category.auditRefs = category.auditRefs.filter(audit => !skipAuditIds.includes(audit.id));

      if (category.auditRefs.length) {
        categories[categoryId] = category;
        category.auditRefs.forEach(audit => includedAudits.add(audit.id));
      }
    });

    return {categories, requestedAuditNames: includedAudits};
  }

  /**
   * @param {LH.Config.Json} config
   * @return {Array<{id: string, title: string}>}
   */
  static getCategories(config) {
    const categories = config.categories;
    if (!categories) {
      return [];
    }
    
    return Object.keys(categories).map(id => {
      const title = categories[id].title;
      return {id, title};
    });
  }

  /**
   * From some requested audits, return names of all required artifacts
   * @param {LH.Config['audits']} audits
   * @return {Set<string>}
   */
  static getGatherersNeededByAudits(audits) {
    // It's possible we weren't given any audits (but existing audit results), in which case
    // there is no need to do any work here.
    if (!audits) {
      return new Set();
    }

    return audits.reduce((list, auditDefn) => {
      auditDefn.implementation.meta.requiredArtifacts.forEach(artifact => list.add(artifact));
      return list;
    }, new Set());
  }

  /**
   * Filters to only required passes and gatherers, returning a new passes array.
   * @param {LH.Config['passes']} passes
   * @param {Set<string>} requiredGatherers
   * @return {LH.Config['passes']}
   */
  static generatePassesNeededByGatherers(passes, requiredGatherers) {
    if (!passes) {
      return null;
    }

    const auditsNeedTrace = requiredGatherers.has('traces');
    const filteredPasses = passes.map(pass => {
      // remove any unncessary gatherers from within the passes
      pass.gatherers = pass.gatherers.filter(gathererDefn => {
        const gatherer = gathererDefn.instance;
        return requiredGatherers.has(gatherer.name);
      });

      // disable the trace if no audit requires a trace
      if (pass.recordTrace && !auditsNeedTrace) {
        const passName = pass.passName || 'unknown pass';
        log.warn('config', `Trace not requested by an audit, dropping trace in ${passName}`);
        pass.recordTrace = false;
      }

      return pass;
    }).filter(pass => {
      // remove any passes lacking concrete gatherers, unless they are dependent on the trace
      if (pass.recordTrace) return true;
      // Always keep defaultPass
      if (pass.passName === 'defaultPass') return true;
      return pass.gatherers.length > 0;
    });
    return filteredPasses;
  }

  /**
   * Take an array of audits and audit paths and require any paths (possibly
   * relative to the optional `configPath`) using `Runner.resolvePlugin`,
   * leaving only an array of Audits.
   * @param {?Array<AuditWithOptions>} audits
   * @param {string=} configPath
   * @return {?Array<LH.Config.AuditDefn>}
   */
  static requireAudits(audits, configPath) {
    if (!audits) {
      return null;
    }

    const coreList = Runner.getAuditList();
    // return audits.map(auditDefn => {
    //   if ('implementation' in auditDefn) {
    //     assertValidAudit(auditDefn.implementation, auditDefn.path);
    //     return auditDefn;
    //   }
    //   const path = auditDefn.path;
    //   // See if the audit is a Lighthouse core audit.
    //   const coreAudit = coreList.find(a => a === `${path}.js`);
    //   let requirePath = `../audits/${path}`;
    //   if (!coreAudit) {
    //     // Otherwise, attempt to find it elsewhere. This throws if not found.
    //     requirePath = Runner.resolvePlugin(path, configPath, 'audit');
    //   }

    //   const newAuditDefn = {
    //     implementation: require(requirePath),
    //     path: auditDefn.path,
    //     options: auditDefn.options
    //   };
    //   assertValidAudit(newAuditDefn.implementation, auditDefn.path);
    //   return newAuditDefn;
    // });

    const mappy = audits.map(audit => {
      let auditDefn;
      let auditPath;
      if ('implementation' in audit) {
        auditDefn = audit;
      } else {
        auditPath = audit.path;
        // See if the audit is a Lighthouse core audit.
        const auditPathJs = `${auditPath}.js`;
        const coreAudit = coreList.find(a => a === auditPathJs);
        let requirePath = `../audits/${auditPath}`;
        if (!coreAudit) {
          // Otherwise, attempt to find it elsewhere. This throws if not found.
          requirePath = Runner.resolvePlugin(auditPath, configPath, 'audit');
        }

        auditDefn = {
          implementation: /** @type {typeof Audit} */ (require(requirePath)),
          path: auditPath,
          options: audit.options,
        };
      }

      assertValidAudit(auditDefn.implementation, auditPath);
      return auditDefn;
    });

    return mappy;
  }

  /**
   *
   * @param {?Array<LH.Config.Pass>} passes
   * @param {string=} configPath
   * @return {?Array<LH.Config.Pass>}
   */
  static requireGatherers(passes, configPath) {
    if (!passes) {
      return null;
    }

    const coreList = Runner.getGathererList();
    passes.forEach(pass => {
      pass.gatherers.forEach(gathererDefn => {
        if (!gathererDefn.instance) {
          let GathererClass = gathererDefn.implementation;
          if (!GathererClass) {
            // See if the gatherer is a Lighthouse core gatherer
            const name = gathererDefn.path;
            const coreGatherer = coreList.find(a => a === `${name}.js`);

            let requirePath = `../gather/gatherers/${name}`;
            if (!coreGatherer) {
              // Otherwise, attempt to find it elsewhere. This throws if not found.
              requirePath = Runner.resolvePlugin(name, configPath, 'gatherer');
            }

            GathererClass = require(requirePath);
          }

          gathererDefn.implementation = GathererClass;
          gathererDefn.instance = new GathererClass();
        }

        assertValidGatherer(gathererDefn.instance, gathererDefn.path);
      });
    });

    return passes;
  }

  // TODO(bckenny): configDir not necessary?
  /** @type {string} */
  get configDir() {
    return this._configDir;
  }

  /** @type {LH.Config['passes']} */
  get passes() {
    return this._passes;
  }

  /** @type {LH.Config['audits']} */
  get audits() {
    return this._audits;
  }

  /** @type {LH.Config['categories']} */
  get categories() {
    return this._categories;
  }

  /** @type {LH.Config['groups']} */
  get groups() {
    return this._groups;
  }

  /** @type {LH.Config['settings']} */
  get settings() {
    return this._settings;
  }
}

/**
 * An intermediate type, stricter than LH.Config.AuditJson but less strict than
 * LH.Config.AuditDefn.
 * // TODO(bckenny): better name? options type?
 * @typedef {{path: string, options: {}} | {implementation: typeof Audit, path?: string, options: {}}} AuditWithOptions
 */

// TODO(bckenny): graduate to real type
/**
 * @typedef {Object} Config.GathererWithOptions
 * @property {string=} path
 * @property {!Gatherer=} instance
 * @property {!GathererConstructor=} implementation
 * @property {Object=} options
 */

module.exports = Config;
