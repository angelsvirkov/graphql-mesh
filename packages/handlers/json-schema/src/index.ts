import { GetMeshSourceOptions, MeshHandler, MeshPubSub, YamlConfig } from '@graphql-mesh/types';
import { JSONSchemaVisitor, getFileName } from './json-schema-visitor';
import urlJoin from 'url-join';
import { readFileOrUrlWithCache, stringInterpolator, parseInterpolationStrings, isUrl } from '@graphql-mesh/utils';
import AggregateError from 'aggregate-error';
import { fetchache, Request, KeyValueCache } from 'fetchache';
import { JSONSchemaDefinition } from './json-schema-types';
import { SchemaComposer } from 'graphql-compose';
import { pathExists, stat, writeJSON } from 'fs-extra';
import toJsonSchema from 'to-json-schema';
import {
  GraphQLJSON,
  GraphQLVoid,
  GraphQLDate,
  GraphQLDateTime,
  GraphQLTime,
  GraphQLTimestamp,
  GraphQLPhoneNumber,
  GraphQLURL,
  GraphQLEmailAddress,
  GraphQLIPv4,
  GraphQLIPv6,
} from 'graphql-scalars';

type CachedSchema = {
  timestamp: number;
  schema: any;
};

export default class JsonSchemaHandler implements MeshHandler {
  public config: YamlConfig.JsonSchemaHandler;
  public cache: KeyValueCache<any>;
  public pubsub: MeshPubSub;
  constructor({ config, cache, pubsub }: GetMeshSourceOptions<YamlConfig.JsonSchemaHandler>) {
    this.config = config;
    this.cache = cache;
    this.pubsub = pubsub;
  }

  public schemaComposer = new SchemaComposer();

  async getMeshSource() {
    const schemaComposer = this.schemaComposer;
    schemaComposer.add(GraphQLJSON);
    schemaComposer.add(GraphQLVoid);
    schemaComposer.add(GraphQLDateTime);
    schemaComposer.add(GraphQLDate);
    schemaComposer.add(GraphQLTime);
    if (!this.config.disableTimestampScalar) {
      schemaComposer.add(GraphQLTimestamp);
    }
    schemaComposer.add(GraphQLPhoneNumber);
    schemaComposer.add(GraphQLURL);
    schemaComposer.add(GraphQLEmailAddress);
    schemaComposer.add(GraphQLIPv4);
    schemaComposer.add(GraphQLIPv6);

    const externalFileCache = new Map<string, any>();
    const inputSchemaVisitor = new JSONSchemaVisitor(
      schemaComposer,
      true,
      externalFileCache,
      this.config.disableTimestampScalar
    );
    const outputSchemaVisitor = new JSONSchemaVisitor(
      schemaComposer,
      false,
      externalFileCache,
      this.config.disableTimestampScalar
    );

    const contextVariables: string[] = [];

    const typeNamedOperations: YamlConfig.JsonSchemaOperation[] = [];
    const unnamedOperations: YamlConfig.JsonSchemaOperation[] = [];

    if (this.config.baseSchema) {
      const basedFilePath = this.config.baseSchema;
      const baseSchema = await readFileOrUrlWithCache(basedFilePath, this.cache, {
        headers: this.config.schemaHeaders,
      });
      externalFileCache.set(basedFilePath, baseSchema);
      const baseFileName = getFileName(basedFilePath);
      outputSchemaVisitor.visit({
        def: baseSchema as JSONSchemaDefinition,
        propertyName: 'Base',
        prefix: baseFileName,
        cwd: basedFilePath,
      });
    }

    this.config?.operations?.forEach(async operationConfig => {
      if (operationConfig.responseTypeName) {
        typeNamedOperations.push(operationConfig);
      } else {
        unnamedOperations.push(operationConfig);
      }
    });

    const handleOperations = async (operationConfig: YamlConfig.JsonSchemaOperation) => {
      let responseTypeName = operationConfig.responseTypeName;

      let [requestSchema, responseSchema] = await Promise.all([
        operationConfig.requestSample &&
          this.generateJsonSchemaFromSample({
            samplePath: operationConfig.requestSample,
            schemaPath: operationConfig.requestSchema,
          }),
        operationConfig.responseSample &&
          this.generateJsonSchemaFromSample({
            samplePath: operationConfig.responseSample,
            schemaPath: operationConfig.responseSchema,
          }),
      ]);
      [requestSchema, responseSchema] = await Promise.all([
        requestSchema ||
          (operationConfig.requestSchema &&
            readFileOrUrlWithCache(operationConfig.requestSchema, this.cache, {
              headers: this.config.schemaHeaders,
            })),
        responseSchema ||
          (operationConfig.responseSchema &&
            readFileOrUrlWithCache(operationConfig.responseSchema, this.cache, {
              headers: this.config.schemaHeaders,
            })),
      ]);
      operationConfig.method = operationConfig.method || (operationConfig.type === 'Mutation' ? 'POST' : 'GET');
      operationConfig.type = operationConfig.type || (operationConfig.method === 'GET' ? 'Query' : 'Mutation');
      const basedFilePath = operationConfig.responseSchema || operationConfig.responseSample;
      if (basedFilePath) {
        externalFileCache.set(basedFilePath, responseSchema);
        const responseFileName = getFileName(basedFilePath);
        responseTypeName = outputSchemaVisitor.visit({
          def: responseSchema as JSONSchemaDefinition,
          propertyName: 'Response',
          prefix: responseFileName,
          cwd: basedFilePath,
          typeName: operationConfig.responseTypeName,
        });
      }

      const { args, contextVariables: specificContextVariables } = parseInterpolationStrings(
        [
          ...Object.values(this.config.operationHeaders || {}),
          ...Object.values(operationConfig.headers || {}),
          operationConfig.path,
        ],
        operationConfig.argTypeMap
      );

      contextVariables.push(...specificContextVariables);

      let requestTypeName = operationConfig.requestTypeName;

      if (requestSchema) {
        const basedFilePath = operationConfig.requestSchema || operationConfig.requestSample;
        externalFileCache.set(basedFilePath, requestSchema);
        const requestFileName = getFileName(basedFilePath);
        requestTypeName = inputSchemaVisitor.visit({
          def: requestSchema as JSONSchemaDefinition,
          propertyName: 'Request',
          prefix: requestFileName,
          cwd: basedFilePath,
          typeName: operationConfig.requestTypeName,
        });
      }

      if (requestTypeName) {
        args.input = {
          type: requestTypeName as any,
          description: requestSchema?.description,
        };
      }

      const destination = operationConfig.type;
      schemaComposer[destination].addFields({
        [operationConfig.field]: {
          description:
            operationConfig.description ||
            responseSchema?.description ||
            `${operationConfig.method} ${operationConfig.path}`,
          type: responseTypeName,
          args,
          resolve: async (root, args, context, info) => {
            const interpolationData = { root, args, context, info };
            if (operationConfig.pubsubTopic) {
              const pubsubTopic = stringInterpolator.parse(operationConfig.pubsubTopic, interpolationData);
              return this.pubsub.asyncIterator(pubsubTopic);
            } else if (operationConfig.path) {
              const interpolatedPath = stringInterpolator.parse(operationConfig.path, interpolationData);
              const fullPath = urlJoin(this.config.baseUrl, interpolatedPath);
              const method = operationConfig.method;
              const headers = {
                ...this.config.operationHeaders,
                ...operationConfig?.headers,
              };
              for (const headerName in headers) {
                headers[headerName] = stringInterpolator.parse(headers[headerName], interpolationData);
              }
              const requestInit: RequestInit = {
                method,
                headers,
              };
              const urlObj = new URL(fullPath);
              const input = args.input;
              if (input) {
                switch (method) {
                  case 'GET':
                  case 'DELETE': {
                    const newSearchParams = new URLSearchParams(input);
                    newSearchParams.forEach((value, key) => {
                      urlObj.searchParams.set(key, value);
                    });
                    break;
                  }
                  case 'POST':
                  case 'PUT': {
                    requestInit.body = JSON.stringify(input);
                    break;
                  }
                  default:
                    throw new Error(`Unknown method ${operationConfig.method}`);
                }
              }
              const request = new Request(urlObj.toString(), requestInit);
              const response = await fetchache(request, this.cache);
              const responseText = await response.text();
              let responseJson: any;
              try {
                responseJson = JSON.parse(responseText);
              } catch (e) {
                throw responseText;
              }
              if (responseJson.errors) {
                throw new AggregateError(responseJson.errors);
              }
              if (responseJson._errors) {
                throw new AggregateError(responseJson._errors);
              }
              if (responseJson.error) {
                throw responseJson.error;
              }
              return responseJson;
            }
          },
        },
      });
    };

    await Promise.all(typeNamedOperations.map(handleOperations));
    await Promise.all(unnamedOperations.map(handleOperations));

    const schema = schemaComposer.buildSchema();
    return {
      schema,
      contextVariables,
    };
  }

  private async isGeneratedJSONSchemaValid({ samplePath, schemaPath }: { samplePath: string; schemaPath?: string }) {
    if (schemaPath || (!isUrl(schemaPath) && (await pathExists(schemaPath)))) {
      const [schemaFileStat, sampleFileStat] = await Promise.all([stat(schemaPath), stat(samplePath)]);
      if (schemaFileStat.mtime > sampleFileStat.mtime) {
        return true;
      }
    }
    return false;
  }

  private async getValidCachedJSONSchema(samplePath: string) {
    const cachedSchema: CachedSchema = await this.cache.get(samplePath);
    if (cachedSchema) {
      const sampleFileStat = await stat(samplePath);
      if (cachedSchema.timestamp > sampleFileStat.mtime.getTime()) {
        return cachedSchema.schema;
      } else {
        this.cache.delete(samplePath);
      }
    }
    return null;
  }

  private async generateJsonSchemaFromSample({ samplePath, schemaPath }: { samplePath: string; schemaPath?: string }) {
    if (!(await this.isGeneratedJSONSchemaValid({ samplePath, schemaPath }))) {
      const cachedSample = await this.getValidCachedJSONSchema(samplePath);
      if (cachedSample) {
        return cachedSample;
      }
      const sample = await readFileOrUrlWithCache(samplePath, this.cache);
      const schema = toJsonSchema(sample, {
        required: false,
        objects: {
          additionalProperties: false,
        },
        strings: {
          detectFormat: true,
        },
        arrays: {
          mode: 'first',
        },
      });
      if (schemaPath) {
        writeJSON(schemaPath, schema);
      } else {
        const cachedSchema = {
          timestamp: Date.now(),
          schema,
        };
        this.cache.set(samplePath, cachedSchema);
      }
      return schema;
    }
    return null;
  }
}
