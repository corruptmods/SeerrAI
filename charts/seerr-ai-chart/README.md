# seerr-ai-chart

![Version: 1.2.1](https://img.shields.io/badge/Version-1.2.1-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 2.4.2](https://img.shields.io/badge/AppVersion-2.4.2-informational?style=flat-square)

Seerr AI helm chart for Kubernetes

**Homepage:** <https://github.com/corruptmods/SeerrAI>

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| corruptmods |  | <https://github.com/corruptmods> |

## Source Code

* <https://github.com/corruptmods/SeerrAI/tree/main/charts/seerr-ai-chart>

## Requirements

Kubernetes: `>=1.23.0-0`

## Installation

```sh
helm install seerr-ai oci://ghcr.io/corruptmods/seerr-ai-chart
```

Then reach it through its service (port 80, `service.port`), an `ingress` or a `route` (below), and follow the setup. Settings, the database and the image cache live in the `config` volume (5 Gi to start; raise `config.persistence.size` for a big library). More in the [install guide](https://github.com/corruptmods/SeerrAI/blob/main/docs/seerr-ai/install.md#kubernetes).

Seerr AI keeps its database in that volume, so it runs as one pod: a StatefulSet. `replicaCount` is 1, or 0 to stop it while keeping the volume (to move or restore it, say); anything else is refused.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` |  |
| config | object | `{"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{},"existingClaim":"","name":"","size":"5Gi","storageClass":"","subPath":"","volumeName":""}}` | Creating PVC to store configuration |
| config.persistence.accessModes | list | `["ReadWriteOnce"]` | Access modes of persistent disk |
| config.persistence.annotations | object | `{}` | Annotations for PVCs |
| config.persistence.existingClaim | string | `""` | Specify an existing `PersistentVolumeClaim` to use. If this value is provided, the default PVC will not be created |
| config.persistence.name | string | `""` | Config name |
| config.persistence.size | string | `"5Gi"` | Size of persistent disk |
| config.persistence.storageClass | string | `""` | Storage class for the PVC. Set to "-" to disable dynamic provisioning. Uses default storage class if no value is provided |
| config.persistence.subPath | string | `""` | Subpath of the pvc which should be mounted |
| config.persistence.volumeName | string | `""` | Name of the permanent volume to reference in the claim. Can be used to bind to existing volumes. |
| dnsConfig | object | `{}` | docs: https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/#pod-dns-config |
| dnsPolicy | string | `""` | docs: https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/#pod-s-dns-policy |
| extraEnv | list | `[]` | Environment variables to add to the Seerr AI pods (TZ, or a PostgreSQL database's DB_TYPE, DB_HOST and so on) |
| extraEnvFrom | list | `[]` | Environment variables from secrets or configmaps to add to the Seerr AI pods |
| fullnameOverride | string | `""` |  |
| hostUsers | bool | `true` | docs: https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/ |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.registry | string | `"ghcr.io"` |  |
| image.repository | string | `"corruptmods/seerr-ai"` |  |
| image.sha | string | `""` |  |
| image.tag | string | `""` | Overrides the image tag whose default is the chart appVersion. |
| imagePullSecrets | list | `[]` |  |
| ingress.annotations | object | `{}` |  |
| ingress.enabled | bool | `false` |  |
| ingress.hosts[0].host | string | `"chart-example.local"` |  |
| ingress.hosts[0].paths[0].path | string | `"/"` |  |
| ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| ingress.ingressClassName | string | `""` |  |
| ingress.tls | list | `[]` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| podLabels | object | `{}` |  |
| podSecurityContext.fsGroup | int | `1000` |  |
| podSecurityContext.fsGroupChangePolicy | string | `"OnRootMismatch"` |  |
| priorityClassName | string | `nil` | Specify a priorityclass, or use default if unset. |
| probes.livenessProbe | object | `{"initialDelaySeconds":20,"periodSeconds":15,"timeoutSeconds":3}` | Configure liveness probe |
| probes.readinessProbe | object | `{"initialDelaySeconds":60,"periodSeconds":15,"timeoutSeconds":3}` | Configure readiness probe |
| probes.startupProbe | string | `nil` | Configure startup probe |
| replicaCount | int | `1` | 1 to run Seerr AI, or 0 to stop it and keep its volume (to move or restore it, say). Never more: it runs as one pod. |
| resources | object | `{}` |  |
| route.main.additionalRules | list | `[]` |  |
| route.main.annotations | object | `{}` |  |
| route.main.apiVersion | string | `"gateway.networking.k8s.io/v1"` | Set the route apiVersion, e.g. gateway.networking.k8s.io/v1 or gateway.networking.k8s.io/v1alpha2 |
| route.main.enabled | bool | `false` | Enables or disables the Gateway API route |
| route.main.filters | list | `[]` |  |
| route.main.hostnames | list | `[]` |  |
| route.main.httpsRedirect | bool | `false` | To redirect to HTTPS, create a new route object under the main route and enable this option. This should only be used with HTTP-like routes, such as HTTPRoute or GRPCRoute. [Reference]( https://gateway-api.sigs.k8s.io/guides/http-redirect-rewrite/ ) |
| route.main.kind | string | `"HTTPRoute"` | Set the route kind. Note that experimental kinds require changing `apiVersion` |
| route.main.labels | object | `{}` |  |
| route.main.matches[0].path.type | string | `"PathPrefix"` |  |
| route.main.matches[0].path.value | string | `"/"` |  |
| route.main.parentRefs | list | `[]` |  |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.privileged | bool | `false` |  |
| securityContext.readOnlyRootFilesystem | bool | `false` |  |
| securityContext.runAsGroup | int | `1000` |  |
| securityContext.runAsNonRoot | bool | `true` |  |
| securityContext.runAsUser | int | `1000` |  |
| securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| service.annotations | object | `{}` |  |
| service.port | int | `80` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` | Annotations to add to the service account |
| serviceAccount.automount | bool | `false` | Automatically mount a ServiceAccount's API credentials? Seerr AI never calls the Kubernetes API. |
| serviceAccount.create | bool | `true` | Specifies whether a service account should be created |
| serviceAccount.name | string | `""` | If not set and create is true, a name is generated using the fullname template |
| tolerations | list | `[]` |  |
| volumeMounts | list | `[]` | Additional volumeMounts on the output StatefulSet definition. |
| volumes | list | `[]` | Additional volumes on the output StatefulSet definition. |
