/*
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import '@elastic/opentelemetry-node'
import './telemetry.js'

import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  Client,
  estypes,
  ClientOptions,
  Transport,
  TransportRequestOptions,
  TransportRequestParams
} from '@elastic/elasticsearch'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'fs'
// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

// Product metadata, used to generate the request User-Agent header and
// passed to the McpServer constructor.
const product = {
  name: 'elasticsearch-mcp',
  version: pkg.version
}

// Prepend a path prefix to every request path
class CustomTransport extends Transport {
  private readonly pathPrefix: string

  constructor (
    opts: ConstructorParameters<typeof Transport>[0],
    pathPrefix: string
  ) {
    super(opts)
    this.pathPrefix = pathPrefix
  }

  async request (
    params: TransportRequestParams,
    options?: TransportRequestOptions
  ): Promise<any> {
    const newParams = { ...params, path: this.pathPrefix + params.path }
    return await super.request(newParams, options)
  }
}

// Configuration schema with auth options
const ConfigSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, 'Elasticsearch URL cannot be empty')
      .url('Invalid Elasticsearch URL format')
      .describe('Elasticsearch server URL'),

    apiKey: z
      .string()
      .optional()
      .describe('API key for Elasticsearch authentication'),

    username: z
      .string()
      .optional()
      .describe('Username for Elasticsearch authentication'),

    password: z
      .string()
      .optional()
      .describe('Password for Elasticsearch authentication'),

    caCert: z
      .string()
      .optional()
      .describe('Path to custom CA certificate for Elasticsearch'),

    pathPrefix: z.string().optional().describe('Path prefix for Elasticsearch'),

    version: z
      .string()
      .optional()
      .transform((val) => (['8', '9'].includes(val || '') ? val : '9'))
      .describe('Elasticsearch version (8, or 9)'),

    sslSkipVerify: z
      .boolean()
      .optional()
      .describe('Skip SSL certificate verification'),

  })
  .refine(
    (data) => {
      // If apiKey is provided, it's valid
      if (data.apiKey != null) return true

      // If username is provided, password must be provided
      if (data.username != null) {
        return data.password != null
      }

      // No auth is also valid (for local development)
      return true
    },
    {
      message:
        'Either ES_API_KEY or both ES_USERNAME and ES_PASSWORD must be provided, or no auth for local development',
      path: ['username', 'password']
    }
  )

type ElasticsearchConfig = z.infer<typeof ConfigSchema>

export async function createElasticsearchMcpServer (config: ElasticsearchConfig): Promise<McpServer> {
  const validatedConfig = ConfigSchema.parse(config)
  const { url, apiKey, username, password, caCert, version, pathPrefix, sslSkipVerify } = validatedConfig

  const clientOptions: ClientOptions = {
    node: url,
    headers: {
      'user-agent': `${product.name}/${product.version}`
    }
  }

  if (pathPrefix != null) {
    const verifiedPathPrefix = pathPrefix
    clientOptions.Transport = class extends CustomTransport {
      constructor (opts: ConstructorParameters<typeof Transport>[0]) {
        super(opts, verifiedPathPrefix)
      }
    }
  }

  // Set up authentication
  if (apiKey != null) {
    clientOptions.auth = { apiKey }
  } else if (username != null && password != null) {
    clientOptions.auth = { username, password }
  }

  // Set up SSL/TLS certificate if provided
  clientOptions.tls = {}
  if (caCert != null && caCert.length > 0) {
    try {
      const ca = fs.readFileSync(caCert)
      clientOptions.tls.ca = ca
    } catch (error) {
      console.error(
        `Failed to read certificate file: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  // Add version-specific configuration
  if (version === '8') {
    clientOptions.maxRetries = 5
    clientOptions.requestTimeout = 30000
    clientOptions.headers = {
      accept: 'application/vnd.elasticsearch+json;compatible-with=8',
      'content-type': 'application/vnd.elasticsearch+json;compatible-with=8'
    }
  }

  // Skip verification if requested
  if (sslSkipVerify != null && sslSkipVerify === true) {
    clientOptions.tls.rejectUnauthorized = false
  }

  const esClient = new Client(clientOptions)

  const server = new McpServer(product)

  // Tool 1: List indices
  server.tool(
    'list_indices',
    'List all available Elasticsearch indices',
    {
      indexPattern: z
        .string()
        .trim()
        .min(1, 'Index pattern is required')
        .describe('Index pattern of Elasticsearch indices to list')
    },
    async ({ indexPattern }) => {
      try {
        const response = await esClient.cat.indices({
          index: indexPattern,
          format: 'json'
        })

        const indicesInfo = response.map((index) => ({
          index: index.index,
          health: index.health,
          status: index.status,
          docsCount: index.docsCount
        }))

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${indicesInfo.length} indices`
            },
            {
              type: 'text' as const,
              text: JSON.stringify(indicesInfo, null, 2)
            }
          ]
        }
      } catch (error) {
        console.error(
          `Failed to list indices: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ]
        }
      }
    }
  )

  // Tool 2: Get mappings for an index
  server.tool(
    'get_mappings',
    'Get field mappings for a specific Elasticsearch index',
    {
      index: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .describe('Name of the Elasticsearch index to get mappings for')
    },
    async ({ index }) => {
      try {
        const mappingResponse = await esClient.indices.getMapping({
          index
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: `Mappings for index: ${index}`
            },
            {
              type: 'text' as const,
              text: `Mappings for index ${index}: ${JSON.stringify(
                mappingResponse[index]?.mappings ?? {},
                null,
                2
              )}`
            }
          ]
        }
      } catch (error) {
        console.error(
          `Failed to get mappings: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ]
        }
      }
    }
  )

  // Tool 3: Search an index with simplified parameters
  server.tool(
    'search',
    'Perform an Elasticsearch search with the provided query DSL. Highlights are always enabled.',
    {
      index: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .describe('Name of the Elasticsearch index to search'),

      queryBody: z
        .record(z.any())
        .refine(
          (val) => {
            try {
              JSON.parse(JSON.stringify(val))
              return true
            } catch (e) {
              return false
            }
          },
          {
            message: 'queryBody must be a valid Elasticsearch query DSL object'
          }
        )
        .describe(
          "Complete Elasticsearch query DSL object that can include query, size, from, sort, etc."
        ),

      profile: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include query profiling information"),

      explain: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include explanation of how the query was executed"),
    },
    async ({ index, queryBody, profile, explain }) => {
      try {
        // Get mappings to identify text fields for highlighting
        const mappingResponse = await esClient.indices.getMapping({
          index
        })

        const indexMappings = mappingResponse[index]?.mappings ?? {}

        const searchRequest: estypes.SearchRequest = {
          index,
          ...queryBody,
          profile,
          explain,
        };

        // Always do highlighting
        if (indexMappings.properties != null) {
          const textFields: Record<string, estypes.SearchHighlightField> = {}

          for (const [fieldName, fieldData] of Object.entries(
            indexMappings.properties
          )) {
            if (fieldData.type === 'text' || 'dense_vector' in fieldData) {
              textFields[fieldName] = {}
            }
          }

          searchRequest.highlight = {
            fields: textFields,
            pre_tags: ['<em>'],
            post_tags: ['</em>']
          }
        }

        const result = await esClient.search(searchRequest)

        // Extract the 'from' parameter from queryBody, defaulting to 0 if not provided
        const from: string | number = queryBody.from ?? 0

        const contentFragments = result.hits.hits.map((hit) => {
          const highlightedFields = hit.highlight ?? {}
          const sourceData = hit._source ?? {}

          let content = ''

          for (const [field, highlights] of Object.entries(highlightedFields)) {
            if (highlights != null && highlights.length > 0) {
              content += `${field} (highlighted): ${highlights.join(
                ' ... '
              )}\n`
            }
          }

          for (const [field, value] of Object.entries(sourceData)) {
            if (!(field in highlightedFields)) {
              content += `${field}: ${JSON.stringify(value)}\n`
            }
          }

          if (explain && hit._explanation) {
            content += `\nExplanation:\n${JSON.stringify(hit._explanation, null, 2)}`
          }

          return {
            type: 'text' as const,
            text: content.trim()
          }
        })

        const metadataFragment = {
          type: 'text' as const,
          text: `Total results: ${
            typeof result.hits.total === 'number'
              ? result.hits.total
              : result.hits.total?.value ?? 0
          }, showing ${result.hits.hits.length} from position ${from}`
        }
        // Check if there are any aggregations in the result and include them
        const aggregationsFragment = (result.aggregations != null)
          ? {
              type: 'text' as const,
              text: `Aggregations: ${JSON.stringify(result.aggregations, null, 2)}`
            }
          : null

        const fragments = [metadataFragment, ...contentFragments]

        if (profile && result.profile) {
          const profileFragment = {
            type: "text" as const,
            text: `\nQuery Profile:\n${JSON.stringify(result.profile, null, 2)}`,
          }
          fragments.push(profileFragment)
        }

        return {
          content: (aggregationsFragment != null)
            ? [metadataFragment, aggregationsFragment, ...contentFragments]
            : [metadataFragment, ...contentFragments]
        }
      } catch (error) {
        console.error(
          `Search failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ]
        }
      }
    }
  )

  // Tool 4: Get shard information
  server.tool(
    'get_shards',
    'Get shard information for all or specific indices',
    {
      index: z
        .string()
        .optional()
        .describe('Optional index name to get shard information for')
    },
    async ({ index }) => {
      try {
        const response = await esClient.cat.shards({
          index,
          format: 'json'
        })

        const shardsInfo = response.map((shard) => ({
          index: shard.index,
          shard: shard.shard,
          prirep: shard.prirep,
          state: shard.state,
          docs: shard.docs,
          store: shard.store,
          ip: shard.ip,
          node: shard.node
        }))

        const metadataFragment = {
          type: 'text' as const,
          text: `Found ${shardsInfo.length} shards${
            index != null ? ` for index ${index}` : ''
          }`
        }

        return {
          content: [
            metadataFragment,
            {
              type: 'text' as const,
              text: JSON.stringify(shardsInfo, null, 2)
            }
          ]
        }
      } catch (error) {
        console.error(
          `Failed to get shard information: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ]
        }
      }
    }
  )

  return server
}

const config: ElasticsearchConfig = {
  url: process.env.ES_URL ?? '',
  apiKey: process.env.ES_API_KEY,
  username: process.env.ES_USERNAME,
  password: process.env.ES_PASSWORD,
  caCert: process.env.ES_CA_CERT,
  version: process.env.ES_VERSION,
  sslSkipVerify: process.env.ES_SSL_SKIP_VERIFY === '1' || process.env.ES_SSL_SKIP_VERIFY === 'true',
  pathPrefix: process.env.ES_PATH_PREFIX
}

async function main (): Promise<void> {
  // If we're running in a container (see Dockerfile), future-proof the command-line
  // by requiring the stdio protocol (http will come later)
  if (process.env.RUNNING_IN_CONTAINER === "true") {
    if (process.argv.length != 3 || process.argv[2] !== "stdio" ) {
      console.log("Missing protocol argument.")
      console.log("Usage: npm start stdio")
      process.exit(1)
    }
  }

  const transport = new StdioServerTransport()
  const server = await createElasticsearchMcpServer(config)

  await server.connect(transport)

  process.on('SIGINT', () => {
    server.close().finally(() => process.exit(0))
  })
}

main().catch((error) => {
  console.error(
    'Server error:',
    error instanceof Error ? error.message : String(error)
  )
  process.exit(1)
})
