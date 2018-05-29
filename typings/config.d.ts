/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import Gatherer = require('../lighthouse-core/gather/gatherers/gatherer.js');
import Audit = require('../lighthouse-core/audits/audit.js');

declare global {
  module LH {
    /**
     * The full, normalized Lighthouse Config.
     */
    export interface Config {
      settings: Config.Settings;
      // TODO(bckenny): these should actually be nullable, not optional?
      passes: Config.Pass[] | null;
      audits: Config.AuditDefn[] | null;
      categories: Record<string, Config.Category> | null;
      groups: Record<string, Config.Group> | null;
    }

    module Config {
      /**
       * The pre-normalization Lighthouse Config format.
       */
      export interface Json {
        extends?: 'lighthouse:default' | 'lighthouse:full' | string | boolean;
        settings?: SettingsJson;
        passes?: PassJson[];
        audits?: Config.AuditJson[];
        categories?: Record<string, CategoryJson>;
        groups?: Record<string, Config.GroupJson>;
      }

      export interface SettingsJson extends SharedFlagsSettings {
        extraHeaders?: Crdp.Network.Headers | null;
      }

      export interface PassJson {
        passName: string;
        recordTrace?: boolean;
        useThrottling?: boolean;
        pauseAfterLoadMs?: number;
        networkQuietThresholdMs?: number;
        cpuQuietThresholdMs?: number;
        blockedUrlPatterns?: string[];
        blankPage?: string;
        blankDuration?: number;
        gatherers?: GathererJson[];
      }

      export type GathererJson = {
        path: string;
        options?: {};
      } | {
        implementation: typeof Gatherer;
        options?: {};
      } | {
        instance: InstanceType<typeof Gatherer>;
        options?: {};
      } | string;

      export interface CategoryJson {
        title: string;
        description: string;
        auditRefs: AuditRefJson[];
      }

      export interface GroupJson {
        title: string;
        description: string;
      }

      export type AuditJson = {
        path: string,
        options?: {};
      } | {
        implementation: typeof Audit;
        options?: {};
      } | typeof Audit | string;

      /**
       * Reference to an audit member of a category and how its score should be
       * weighted and how its results grouped with other members.
       */
      export interface AuditRefJson {
        id: string;
        weight: number;
        group?: string;
      }

      export interface Settings extends Required<SettingsJson> {
        throttling: Required<ThrottlingSettings>;
      }

      export interface Pass extends Required<PassJson> {
        gatherers: GathererDefn[];
      }

      export interface GathererDefn {
        implementation: typeof Gatherer;
        instance: InstanceType<typeof Gatherer>;
        options: {};
      }

      export interface AuditDefn {
        implementation: typeof Audit;
        path?: string;
        options: {};
      }

      // TODO: For now, these are unchanged from JSON and Result versions. Need to harmonize.
      export interface AuditRef extends AuditRefJson {}
      export interface Category extends CategoryJson {
        auditRefs: AuditRef[];
      }
      export interface Group extends GroupJson {}
    }
  }
}

// empty export to keep file a module
export {}
