A static site in a private S3 bucket, served worldwide through CloudFront, and a public Route 53 zone of the lab's own that answers with weighted and failover routing and watches the site with a health check. The zone is never delegated, so you ask its own name servers directly (the Connect lines do). Run the Connect lines and the Things to try in AWS CloudShell (London) after `sudo dnf install -y bind-utils`, because `dig` is not pre-installed there. The bucket is listed in the lab's resource group, `lab-soa-09-route53-cloudfront`, in AWS Resource Groups (London); the distribution, the zone and the health check are global: find them under CloudFront and Route 53.
From the SOA-C03 outline: configure Amazon Route 53 hosted zones, routing policies and health checks, and configure Amazon CloudFront distributions with an S3 origin and origin access control.

## What it deploys

- The bucket `cloudlabs-<name prefix>-site` with `index.html` and `health.html`, every public access block on, and a bucket policy that lets only CloudFront read it
- The distribution `cdn-site` (Europe and North America edges) with the origin access control `lab-soa-09-route53-cloudfront-<name prefix>`; pages are cached and served over HTTPS, while `/health.html` is never cached and also answers HTTP
- The public hosted zone `<name prefix>.labs.clydeford.net`, not delegated, with `blue`, `green` and `sorry` (all to the distribution), `app` (weighted: blue 70, green 30), `www` (failover: blue while the health check passes, sorry when it fails) and `cdn` (an alias to the distribution)
- The health check `hc-primary`: HTTP, every 30 seconds, `/health.html` on the distribution, three failures to fail

```text
lab-soa-09-route53-cloudfront (London; CloudFront and Route 53 are global)
  you --https--> cdn-site (CloudFront) --origin access control--> bucket cloudlabs-<prefix>-site (private)
  zone <prefix>.labs.clydeford.net (not delegated: dig @its name server)
    app  -> blue (70) | green (30)          weighted
    www  -> blue (primary, hc-primary) | sorry (secondary)    failover
    cdn  -> alias to cdn-site
  hc-primary --HTTP /health.html every 30 s--> cdn-site
```

## Things to try

- Run the third Connect line a few times: about seven answers in ten are `blue.<zone>` and three `green.<zone>`. Change the weights in Route 53 (green to 0, then both to 0) and see what a weight of zero does.
- Delete `health.html` (the fourth Connect line) and watch `hc-primary` turn unhealthy in Route 53, Health checks (about a minute and a half), then ask for `www` again (the second line): it now answers `sorry`. Upload it again (`aws s3 cp` any small file to the same key) and watch it fail back.
- Try the bucket directly: `curl -I https://cloudlabs-<name prefix>-site.s3.eu-west-2.amazonaws.com/index.html` answers 403, while the distribution serves the page. Read the bucket policy and the origin access control to see why.
- Change `index.html` in the bucket and fetch the site: CloudFront still serves the old page from cache. Create an invalidation for `/index.html` (CloudFront, the distribution, Invalidations; the first 1,000 paths a month are free) and fetch again.
- In CloudFront, open the distribution's **Behaviors** and compare the default behaviour with `/health.html`'s: cache policy, viewer protocol and why the health check needs both.

## Learn more

- [Choosing a routing policy](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html)
- [Configuring DNS failover](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-configuring.html)
- [Creating Amazon Route 53 health checks](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating.html)
- [Restricting access to an Amazon S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [Using the managed cache policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html)
- [Invalidating files](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-09-route53-cloudfront` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
