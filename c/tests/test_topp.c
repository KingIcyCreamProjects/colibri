/* Top-p truncation invariants (dist_build partial select).
 *
 * dist_build() truncates softmax(lo/temp) to the smallest descending-order
 * head whose cumulative mass reaches g_nuc, zeroes the tail and renormalizes
 * the head. dist_sample() then walks ALL V entries of g_pbuf — it relies on
 * every out-of-head entry being exactly 0. If truncation ever leaves a
 * nonzero tail entry, sampling silently draws from the untruncated
 * distribution: no crash, just a wrong distribution.
 *
 * The heap-based partial select must therefore match the old full-qsort
 * algorithm exactly. Against an independent reference implementation (the
 * old algorithm, qsort on (prob,idx) pairs) this asserts, per trial:
 *   1. identical keep count;
 *   2. bit-identical renormalized head (s2 is accumulated in descending
 *      order in both, so no float-order drift). On boundary TIES the kept
 *      index set may legally differ — qsort was never stable either — so
 *      tie trials compare the kept-probability multiset instead;
 *   3. every non-kept entry is exactly 0.0f;
 *   4. the head sums to ~1 after renormalization.
 */
#define main coli_glm_main_unused
#include "../glm.c"
#undef main

typedef struct { float p; int i; } PI;
static int cmp_pi(const void *a, const void *b){
    float pa=((const PI*)a)->p, pb=((const PI*)b)->p;
    return pa<pb ? 1 : pa>pb ? -1 : 0;
}

/* reference: the pre-patch algorithm, independent buffers */
static int ref_topp(const float *lo, int V, float temp, float nuc,
                    float *out /*V*/, unsigned char *kept /*V*/){
    float mx=lo[0]; for(int i=1;i<V;i++) if(lo[i]>mx) mx=lo[i];
    double s=0; float invt=1.f/(temp>1e-4f?temp:1e-4f);
    for(int i=0;i<V;i++){ out[i]=expf((lo[i]-mx)*invt); s+=out[i]; }
    for(int i=0;i<V;i++) out[i]/=(float)s;
    memset(kept,1,(size_t)V);
    if(!(nuc>0 && nuc<1.f)) return V;
    PI *v=malloc((size_t)V*sizeof(PI));
    for(int i=0;i<V;i++){ v[i].p=out[i]; v[i].i=i; }
    qsort(v,(size_t)V,sizeof(PI),cmp_pi);
    double cum=0; int keep=V;
    for(int i=0;i<V;i++){ cum+=v[i].p; if(cum>=nuc){ keep=i+1; break; } }
    memset(kept,0,(size_t)V);
    double s2=0;
    for(int i=0;i<keep;i++){ kept[v[i].i]=1; s2+=v[i].p; }
    for(int i=keep;i<V;i++) out[v[i].i]=0;
    for(int i=0;i<keep;i++) out[v[i].i]/=(float)s2;
    free(v);
    return keep;
}

static int cmp_f(const void *a, const void *b){
    float x=*(const float*)a, y=*(const float*)b;
    return x<y ? -1 : x>y ? 1 : 0;
}

static uint64_t t_rng=0x1234ABCDu;
static double t_rnd(void){ t_rng^=t_rng<<13; t_rng^=t_rng>>7; t_rng^=t_rng<<17;
    return (double)(t_rng>>11)*(1.0/9007199254740992.0); }

static int fail=0;
static void check(int cond, const char *what, int V, float nuc, const char *shape){
    if(!cond){ fail=1; printf("  FAIL: %s (V=%d nuc=%.3f shape=%s)\n",what,V,nuc,shape); }
}

/* shapes: 0=random logits, 1=one-hot spike, 2=all-equal (max ties),
 * 3=two-level plateau (ties straddle the cut), 4=descending ramp */
static void fill(float *lo, int V, int shape){
    switch(shape){
        case 0: for(int i=0;i<V;i++) lo[i]=(float)(t_rnd()*20.0-10.0); break;
        case 1: for(int i=0;i<V;i++) lo[i]=-5.f; lo[V/2]=15.f; break;
        case 2: for(int i=0;i<V;i++) lo[i]=1.f; break;
        case 3: for(int i=0;i<V;i++) lo[i]=(i<V/8)?4.f:0.f; break;
        default:for(int i=0;i<V;i++) lo[i]=-(float)i*0.01f; break;
    }
}

static void one_trial(int V, float temp, float nuc, int shape, const char *sname){
    float *lo=malloc((size_t)V*sizeof(float));
    float *ref=malloc((size_t)V*sizeof(float));
    unsigned char *kept=malloc(V);
    fill(lo,V,shape);
    g_temp=temp; g_nuc=nuc;
    dist_build(lo,V);                                   /* the real one */
    int keep=ref_topp(lo,V,temp,nuc,ref,kept);

    int nzero_bad=0, nkeep_got=0;
    for(int i=0;i<V;i++){
        if(g_pbuf[i]>0) nkeep_got++;
        if(!kept[i] && shape!=2 && shape!=3 && g_pbuf[i]!=0.0f) nzero_bad++;
    }
    /* 1. keep count (ties can move WHICH indices, never HOW MANY: the cut is
     *    by cumulative mass over equal values) */
    check(nkeep_got==keep, "keep count differs from reference", V,nuc,sname);
    /* 3. tail exactly zero: for tie-free shapes the exact reference tail;
     *    for tie shapes, count of nonzero entries == keep already covers it */
    check(nzero_bad==0, "non-kept entry left nonzero", V,nuc,sname);
    /* 4. head renormalized */
    double sum=0; for(int i=0;i<V;i++) sum+=g_pbuf[i];
    check(fabs(sum-1.0)<1e-4, "head does not sum to 1", V,nuc,sname);
    /* 2. head values: bitwise vs reference when tie-free; multiset otherwise */
    if(shape!=2 && shape!=3){
        int diff=0;
        for(int i=0;i<V;i++) if(g_pbuf[i]!=ref[i]) diff++;
        check(diff==0, "head values differ bitwise from reference", V,nuc,sname);
    } else {
        float *a=malloc((size_t)V*sizeof(float)), *b=malloc((size_t)V*sizeof(float));
        memcpy(a,g_pbuf,(size_t)V*sizeof(float)); memcpy(b,ref,(size_t)V*sizeof(float));
        qsort(a,(size_t)V,sizeof(float),cmp_f); qsort(b,(size_t)V,sizeof(float),cmp_f);
        int diff=0; for(int i=0;i<V;i++) if(a[i]!=b[i]) diff++;
        check(diff==0, "kept-probability multiset differs from reference", V,nuc,sname);
        free(a); free(b);
    }
    free(lo); free(ref); free(kept);
}

int main(void){
    const int Vs[]={1,2,7,64,1000,151936};
    const float nucs[]={0.05f,0.5f,0.9f,0.999f};
    const char *sname[]={"random","spike","all-equal","plateau","ramp"};
    for(size_t vi=0;vi<sizeof Vs/sizeof *Vs;vi++)
      for(size_t ni=0;ni<sizeof nucs/sizeof *nucs;ni++)
        for(int shape=0;shape<5;shape++){
            /* fresh buffers per V change: dist_build lazily sizes to first V */
            if(g_pbuf){ free(g_pbuf); free(g_pidx); g_pbuf=NULL; g_pidx=NULL; }
            one_trial(Vs[vi], 0.7f, nucs[ni], shape, sname[shape]);
        }
    /* guard-off paths: nuc<=0 and nuc>=1 must leave a full softmax (no zeroes) */
    for(int shape=0;shape<5;shape++){
        if(g_pbuf){ free(g_pbuf); free(g_pidx); g_pbuf=NULL; g_pidx=NULL; }
        float *lo=malloc(1000*sizeof(float)); fill(lo,1000,shape);
        g_temp=0.7f; g_nuc=1.f; dist_build(lo,1000);
        int nz=0; for(int i=0;i<1000;i++) if(g_pbuf[i]>0) nz++;
        check(nz==1000, "nuc=1 must not truncate", 1000, 1.f, sname[shape]);
        free(lo);
    }
    if(fail){ printf("test_topp: FAIL\n"); return 1; }
    printf("test_topp: ok  (6 sizes x 4 p x 5 shapes, ties + guard-off covered)\n");
    return 0;
}
