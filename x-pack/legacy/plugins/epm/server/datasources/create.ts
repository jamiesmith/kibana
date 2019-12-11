/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { SavedObjectsClientContract } from 'src/core/server/';
import { Asset, Datasource, InputType } from '../../../ingest/server/libs/types';
import { SAVED_OBJECT_TYPE_DATASOURCES } from '../../common/constants';
import { AssetReference, InstallationStatus, RegistryPackage } from '../../common/types';
import { CallESAsCurrentUser } from '../lib/cluster_access';
import { installILMPolicy, policyExists } from '../lib/elasticsearch/ilm/install';
import { installPipelines } from '../lib/elasticsearch/ingest_pipeline/ingest_pipelines';
import { installTemplates } from '../lib/elasticsearch/template/install';
import { getPackageInfo, PackageNotInstalledError } from '../packages';
import * as Registry from '../registry';

export async function createDatasource(options: {
  savedObjectsClient: SavedObjectsClientContract;
  pkgkey: string;
  callCluster: CallESAsCurrentUser;
}) {
  const { savedObjectsClient, pkgkey, callCluster } = options;
  const packageInfo = await getPackageInfo({ savedObjectsClient, pkgkey });

  if (packageInfo.status !== InstallationStatus.installed) {
    throw new PackageNotInstalledError(pkgkey);
  }

  const toSave = await installPipelines({ pkgkey, callCluster });
  // TODO: Clean up
  const info = await Registry.fetchInfo(pkgkey);

  // TODO: This should be moved out of the initial data source creation in the end
  await baseSetup(callCluster);
  await installTemplates(info, callCluster);
  const pkg = await Registry.fetchInfo(pkgkey);

  await Promise.all([
    installTemplates(pkg, callCluster),
    saveDatasourceReferences({
      savedObjectsClient,
      pkg,
      toSave,
    }),
  ]);

  return toSave;
}

/**
 * Makes the basic setup of the assets like global ILM policies. Creates them if they do
 * not exist yet but will not overwrite existing once.
 */
async function baseSetup(callCluster: CallESAsCurrentUser) {
  if (!(await policyExists('logs-default', callCluster))) {
    await installILMPolicy('logs-default', callCluster);
  }
  if (!(await policyExists('metrics-default', callCluster))) {
    await installILMPolicy('metrics-default', callCluster);
  }
}

async function saveDatasourceReferences(options: {
  savedObjectsClient: SavedObjectsClientContract;
  pkg: RegistryPackage;
  toSave: AssetReference[];
}) {
  const { savedObjectsClient, pkg, toSave } = options;
  const savedDatasource = await getDatasource({ savedObjectsClient, pkg });
  const savedAssets = savedDatasource?.package.assets;
  const assetsReducer = (current: Asset[] = [], pending: Asset) => {
    const hasAsset = current.find(c => c.id === pending.id && c.type === pending.type);
    if (!hasAsset) current.push(pending);
    return current;
  };

  const toInstall = (toSave as Asset[]).reduce(assetsReducer, savedAssets);
  const datasource: Datasource = createFakeDatasource(pkg, toInstall);
  await savedObjectsClient.create<Datasource>(SAVED_OBJECT_TYPE_DATASOURCES, datasource, {
    id: Registry.pkgToPkgKey(pkg),
    overwrite: true,
  });

  return toInstall;
}

async function getDatasource(options: {
  savedObjectsClient: SavedObjectsClientContract;
  pkg: RegistryPackage;
}) {
  const { savedObjectsClient, pkg } = options;
  const datasource = await savedObjectsClient
    .get<Datasource>(SAVED_OBJECT_TYPE_DATASOURCES, Registry.pkgToPkgKey(pkg))
    .catch(e => undefined);

  return datasource?.attributes;
}

function createFakeDatasource(pkg: RegistryPackage, assets: Asset[] = []): Datasource {
  return {
    id: Registry.pkgToPkgKey(pkg),
    name: 'name',
    read_alias: 'read_alias',
    package: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      title: pkg.title,
      assets,
    },
    streams: [
      {
        id: 'string',
        input: {
          type: InputType.Log,
          config: { config: 'values', go: 'here' },
          ingest_pipelines: ['string'],
          id: 'string',
          index_template: 'string',
          ilm_policy: 'string',
          fields: [{}],
        },
        config: { config: 'values', go: 'here' },
        output_id: 'output_id',
        processors: ['string'],
      },
    ],
  };
}